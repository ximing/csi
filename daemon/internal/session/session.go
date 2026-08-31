// Package session 维护 session → 标签集 的状态（协议 §3.4）。
package session

import (
	"sort"
	"sync"
)

// Session 单个会话的标签状态。
type Session struct {
	TabIDs       []int  // 该 session 拥有的全部 tabId
	CurrentTabID int    // 当前目标（owned 或 borrowed）；0 = 无
	Borrowed     bool   // CurrentTabID 是否为借用（不在 TabIDs 中）
	GroupTitle   string // navigate 时指定的 group_title

	gate *fifo
}

// Manager 管理全部 session。
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
}

// NewManager 创建 Manager。
func NewManager() *Manager {
	return &Manager{sessions: make(map[string]*Session)}
}

func (m *Manager) get(name string) *Session {
	s, ok := m.sessions[name]
	if !ok {
		s = &Session{gate: &fifo{}}
		m.sessions[name] = s
	}
	if s.gate == nil {
		s.gate = &fifo{}
	}
	return s
}

// Acquire 按 session 名 FIFO 锁住完整 Execute（协议 §3.4）。
// 先短持 m.mu 取 gate，再 fifo.Lock，避免 /status 的 Names() 被长工具卡住。
func (m *Manager) Acquire(name string) func() {
	m.mu.Lock()
	s := m.get(name)
	g := s.gate
	m.mu.Unlock()
	g.Lock()
	return func() { g.Unlock() }
}

// Inject 按协议 §3.4 向 args 注入 _session/_tabId/_tabIds/_borrowed。
// 调用方传入的 _ 前缀字段一律被覆盖。返回新的 args map（不改调用方的 map）。
func (m *Manager) Inject(name string, args map[string]any) map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()

	s := m.get(name)
	if gt, ok := args["group_title"].(string); ok && gt != "" {
		s.GroupTitle = gt
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

	s := m.get(name)
	d, _ := data.(map[string]any)
	success, _ := d["success"].(bool)

	switch tool {
	case "close_tab":
		closed, _ := d["closed"].(bool)
		reason, _ := d["reason"].(string)
		if closed {
			forgetTabLocked(s, s.CurrentTabID)
			return
		}
		if reason == "borrowed target is not owned by this session" {
			return
		}
		if reason == "tab already closed" {
			forgetTabLocked(s, s.CurrentTabID)
		}
	case "close_session":
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

// ForgetTab 从 owned 集移除失效 tab；若当前目标指向它则回退到最后一个 owned 或 0。
// 返回新的 CurrentTabID（0 表示没有 next）。不重放原工具。
func (m *Manager) ForgetTab(name string, tabId int) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return forgetTabLocked(m.get(name), tabId)
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
