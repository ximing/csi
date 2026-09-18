// Package session 维护 session → 标签集 的状态（协议 §3.4）。
package session

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const (
	// MaxSessions session 数上限；超出时只淘汰空 owned 集且未持锁的 LRU；无受害者则跳过（协议 §3.4）。
	MaxSessions = 256
	// MaxNameLength session 名长度上限（按字节，len()），防失控客户端刷爆内存。
	MaxNameLength = 128
	// IdleTTL 闲置回收阈值；仅空 owned 集且未持锁的 session 可回收（协议 §3.4）。
	IdleTTL      = 24 * time.Hour
	sessionsFile = "sessions.json"
)

// Session 单个会话的标签状态。
type Session struct {
	TabIDs       []int  // 该 session 拥有的全部 tabId
	CurrentTabID int    // 当前目标（owned 或 borrowed）；0 = 无
	Borrowed     bool   // CurrentTabID 是否为借用（不在 TabIDs 中）
	GroupTitle   string // navigate 时指定的 group_title

	gate       *fifo
	lastUsed   int64     // 访问序号（LRU 依据，Manager.seq 单调递增）
	lastAccess time.Time // 最近访问墙钟时间（闲置回收依据）
}

// Manager 管理全部 session。
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	seq      int64
	dir      string // 非空则落盘 sessions.json（协议 §3.4）；空 = 纯内存
	// Now 注入时钟（测试用）；nil 时用 time.Now。
	Now func() time.Time
}

// persistedSession 落盘形状，不含 gate / lastAccess（协议 §3.4）。
type persistedSession struct {
	TabIDs       []int  `json:"tabIds"`
	CurrentTabID int    `json:"currentTabId"`
	Borrowed     bool   `json:"borrowed"`
	GroupTitle   string `json:"groupTitle"`
}

// NewManager 创建纯内存 Manager（测试用；不落盘）。
func NewManager() *Manager {
	return &Manager{sessions: make(map[string]*Session)}
}

// NewManagerPersist 从 dir/sessions.json 加载；缺失或损坏当空表。
// 加载后的 session 视为刚访问，不立刻 TTL（协议 §3.4）。
func NewManagerPersist(dir string) *Manager {
	m := &Manager{sessions: make(map[string]*Session), dir: dir}
	m.load()
	return m
}

func (m *Manager) load() {
	if m.dir == "" {
		return
	}
	data, err := os.ReadFile(filepath.Join(m.dir, sessionsFile))
	if err != nil {
		return
	}
	var in map[string]persistedSession
	if json.Unmarshal(data, &in) != nil {
		return
	}
	now := m.now()
	for name, p := range in {
		m.seq++
		tabIDs := make([]int, len(p.TabIDs))
		copy(tabIDs, p.TabIDs)
		m.sessions[name] = &Session{
			TabIDs:       tabIDs,
			CurrentTabID: p.CurrentTabID,
			Borrowed:     p.Borrowed,
			GroupTitle:   p.GroupTitle,
			gate:         &fifo{},
			lastUsed:     m.seq,
			lastAccess:   now,
		}
	}
}

// saveLocked 原子写 sessions.json（临时文件 + Rename）。dir 为空则跳过。
func (m *Manager) saveLocked() {
	if m.dir == "" {
		return
	}
	out := make(map[string]persistedSession, len(m.sessions))
	for name, s := range m.sessions {
		tabIDs := make([]int, len(s.TabIDs))
		copy(tabIDs, s.TabIDs)
		out[name] = persistedSession{
			TabIDs:       tabIDs,
			CurrentTabID: s.CurrentTabID,
			Borrowed:     s.Borrowed,
			GroupTitle:   s.GroupTitle,
		}
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return
	}
	path := filepath.Join(m.dir, sessionsFile)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
	}
}

func (m *Manager) get(name string) *Session {
	m.seq++
	now := m.now()
	m.sweepLocked(now) // 每次访问顺带清扫（≤256 项，代价可忽略），不只 miss 路径
	if s, ok := m.sessions[name]; ok {
		s.lastUsed, s.lastAccess = m.seq, now
		if s.gate == nil {
			s.gate = &fifo{}
		}
		return s
	}
	if len(m.sessions) >= MaxSessions {
		m.evictLRULocked()
	}
	s := &Session{gate: &fifo{}, lastUsed: m.seq, lastAccess: now}
	m.sessions[name] = s
	return s
}

func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

// sweepLocked 惰性清扫闲置超 TTL 的 session。
// 有 owned tab（len(TabIDs)>0）或持有锁（busy）的跳过（协议 §3.4）。
func (m *Manager) sweepLocked(now time.Time) {
	for n, s := range m.sessions {
		if len(s.TabIDs) > 0 || s.gate.busy() {
			continue
		}
		if now.Sub(s.lastAccess) > IdleTTL {
			delete(m.sessions, n)
		}
	}
}

// evictLRULocked 只在空 owned 集且未持锁的 session 里挑 LRU；没有受害者则 no-op（协议 §3.4）。
func (m *Manager) evictLRULocked() {
	var victim string
	var min int64 = math.MaxInt64
	for n, s := range m.sessions {
		if len(s.TabIDs) > 0 || s.gate.busy() {
			continue
		}
		if s.lastUsed < min {
			min, victim = s.lastUsed, n
		}
	}
	if victim != "" {
		delete(m.sessions, victim)
	}
}

// Acquire 按 session 名 FIFO 锁住完整 Execute（协议 §3.4）。
// 先短持 m.mu 取 gate，再 fifo.LockCtx，避免 /status 的 Names() 被长工具卡住。
// 排队期间 ctx 取消则不入临界区，返回 ctx.Err()（release 为 nil，不可调用）。
func (m *Manager) Acquire(ctx context.Context, name string) (func(), error) {
	m.mu.Lock()
	s := m.get(name)
	g := s.gate
	m.mu.Unlock()
	if err := g.LockCtx(ctx); err != nil {
		return nil, err
	}
	return func() { g.Unlock() }, nil
}

// Inject 按协议 §3.4 向 args 注入 _session/_tabId/_tabIds/_borrowed。
// 调用方传入的 _ 前缀字段一律被覆盖。返回新的 args map（不改调用方的 map）。
func (m *Manager) Inject(name string, args map[string]any) map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()

	s := m.get(name)
	if gt, ok := args["group_title"].(string); ok && gt != "" && gt != s.GroupTitle {
		s.GroupTitle = gt
		m.saveLocked()
	}

	out := make(map[string]any, len(args)+4)
	for k, v := range args {
		out[k] = v
	}
	out["_session"] = name
	out["_tabId"] = s.CurrentTabID
	tabIDs := make([]int, len(s.TabIDs))
	copy(tabIDs, s.TabIDs)
	out["_tabIds"] = tabIDs
	out["_borrowed"] = s.Borrowed
	return out
}

// Update 工具返回后按 tabId/close 语义更新 session 状态（协议 §3.4）。
func (m *Manager) Update(name, tool string, data any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	defer m.saveLocked()

	s := m.get(name)
	d, _ := data.(map[string]any)
	success, _ := d["success"].(bool)

	switch tool {
	case "close_tab":
		closed, _ := d["closed"].(bool)
		if closed {
			forgetTabLocked(s, s.CurrentTabID)
			return
		}
		// 对账只看结构化 code（协议 §3.4）：already_closed 才移出 owned 集；
		// not_owned / close_failed 下 tab 可能仍在，绝不能 forget。
		if code, _ := d["code"].(string); code == "already_closed" {
			forgetTabLocked(s, s.CurrentTabID)
		}
	case "close_session":
		// remaining 在：把 owned 集替换为仍活着的 tab（部分 close_failed）。
		// 缺 remaining 且 success：旧扩展 / 全部已关 → 整表清空（协议 §3.4）。
		if remaining, ok := toIntSlice(d["remaining"]); ok {
			s.TabIDs = remaining
			if !containsInt(s.TabIDs, s.CurrentTabID) {
				s.CurrentTabID = 0
				s.Borrowed = false
				if n := len(s.TabIDs); n > 0 {
					s.CurrentTabID = s.TabIDs[n-1]
				}
			}
			return
		}
		if success {
			s.TabIDs = nil
			s.CurrentTabID = 0
			s.Borrowed = false
		}
	case "navigate":
		if tid, ok := toInt(d["tabId"]); ok && tid > 0 {
			if tid == s.CurrentTabID && s.Borrowed {
				// 扩展错误地把用户 tab 收编进来：拒绝写入 owned。
				return
			}
			adoptOwned(s, tid)
		}
	case "find_tab":
		if tid, ok := toInt(d["tabId"]); ok && tid > 0 {
			borrowed, _ := d["borrowed"].(bool)
			if borrowed && containsInt(s.TabIDs, tid) {
				adoptOwned(s, tid)
				return
			}
			if borrowed {
				s.CurrentTabID = tid
				s.Borrowed = true
				return
			}
			adoptOwned(s, tid)
		}
	default:
		if borrowed, _ := d["borrowed"].(bool); borrowed {
			return
		}
		if tid, ok := toInt(d["tabId"]); ok && tid > 0 {
			adoptOwned(s, tid)
		}
	}
}

// CurrentTab 返回 session 当前目标 tabId（0 = 无）。
func (m *Manager) CurrentTab(name string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.get(name).CurrentTabID
}

// ForgetTab 从 owned 集移除失效 tab；若当前目标指向它则回退到最后一个 owned 或 0。
// 返回新的 CurrentTabID（0 表示没有 next）。不重放原工具。
func (m *Manager) ForgetTab(name string, tabId int) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	next := forgetTabLocked(m.get(name), tabId)
	m.saveLocked()
	return next
}

func forgetTabLocked(s *Session, tabId int) int {
	s.TabIDs = removeInt(s.TabIDs, tabId)
	if s.CurrentTabID == tabId {
		s.CurrentTabID = 0
		s.Borrowed = false
		if n := len(s.TabIDs); n > 0 {
			s.CurrentTabID = s.TabIDs[n-1]
		}
	}
	return s.CurrentTabID
}

func adoptOwned(s *Session, tid int) {
	if !containsInt(s.TabIDs, tid) {
		s.TabIDs = append(s.TabIDs, tid)
	}
	s.CurrentTabID = tid
	s.Borrowed = false
}

// Names 返回全部 session 名（排序，供 /status 使用）。
func (m *Manager) Names() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	names := make([]string, 0, len(m.sessions))
	for n := range m.sessions {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// Snapshot 返回 session 状态副本（测试用）。
func (m *Manager) Snapshot(name string) Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.get(name)
	return Session{
		TabIDs:       append([]int(nil), s.TabIDs...),
		CurrentTabID: s.CurrentTabID,
		Borrowed:     s.Borrowed,
		GroupTitle:   s.GroupTitle,
	}
}

func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	}
	return 0, false
}

func toIntSlice(v any) ([]int, bool) {
	switch s := v.(type) {
	case []int:
		return append([]int(nil), s...), true
	case []any:
		out := make([]int, 0, len(s))
		for _, x := range s {
			n, ok := toInt(x)
			if !ok || n <= 0 {
				continue
			}
			out = append(out, n)
		}
		return out, true
	}
	return nil, false
}

func containsInt(s []int, v int) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func removeInt(s []int, v int) []int {
	out := s[:0]
	for _, x := range s {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}
