# 推广就绪修复 + 手动/自动更新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉推广前必须处理的发版/健壮性问题,并为 daemon 落地手动+定时自动更新机制。

**Architecture:** 三个工作流:A=发版(CI 测试闸、ldflags 注入版本、12 处版本表面对齐守卫、商店合规);B=健壮性(WS 写 deadline、session map LRU+TTL 回收、扩展断线退避重连、popup 显示 daemon 版本);C=更新(daemon 新增 `internal/update` 包 + `csi update`/`csi uninstall` 子命令、autostart 框架扩展出每日定时任务、安装器升级语义修复、README 文档)。

**Tech Stack:** Go 1.26(daemon,标准库为主)、TypeScript + vitest(extension)、GitHub Actions、bash/PowerShell 安装器。

**Spec:** `docs/superpowers/specs/2026-09-02-rollout-readiness-and-update-design.md`

## Global Constraints

- **不改 `docs/protocol.md`**:本计划不动 WS 协议;`/status` 新字段是 HTTP 面,文档落 `skills/csi/references/operations.md`。
- **不做 HTTP 鉴权 / Origin 校验**(用户决策,本地回环信任模型)。
- **业务错误一律放响应 body 的 `error` 字段,HTTP 状态码只用于传输层错误**(daemon/CLAUDE.md;session 名过长也走 body error,不用 400)。
- **双端 parity 是硬约束**:`install.sh` 与 `install.ps1` 必须同时改(scripts/CLAUDE.md)。
- **PowerShell 兼容 5.1**,不用 7+ 专属语法。
- 代码注释用中文,引用协议章节写 `协议 §x.y`。
- 提交信息用中文、随意风格;每个任务结束提交,**只 `git add` 本任务涉及的文件**(工作区有大量与本计划无关的已暂存改动,严禁 `git add -A`/`git add .`)。
- macOS 无 `sha256sum`,用 `shasum -a 256`;跨端写法见任务内代码。
- launchd 单元**禁止 `KeepAlive`**;systemd **禁止 `Restart=`**(autostart/generate.go 现有约束,定时任务用独立单元,不违反)。

---

## 工作流 A:发版修复

### Task 1: release CI 测试闸 + ldflags 版本注入

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `daemon/internal/version/version.go`

**Interfaces:**
- Produces: `version.Version` 由 const 变 `var`(string),release 构建经 `-X csi/daemon/internal/version.Version=<tag去v>` 覆盖;本地构建仍是源码兜底值。下游所有 `version.Version` 消费方(`server.go:47,145`、`main.go:42`、`commands.go:80`)无需改。

- [ ] **Step 1: 写失败测试(version 可被 ldflags 覆盖的形式)**

`daemon/internal/version/version_test.go`(新建):

```go
package version

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// Version 必须是 string var 而非 const,否则 release 的 -X 注入静默无效。
func TestVersionIsVar(t *testing.T) {
	f, err := parser.ParseFile(token.NewFileSet(), "version.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, decl := range f.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok {
			continue
		}
		if gd.Tok == token.CONST {
			t.Fatal("Version 不允许声明为 const(release 需要 -X ldflags 注入)")
		}
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && go test ./internal/version/`
Expected: FAIL("不允许声明为 const")

- [ ] **Step 3: version.go const → var**

```go
// Package version 定义 daemon 版本。
package version

// Version 当前 daemon 版本(协议 §6,hello_ack 中交换)。
// 开发期兜底值;release 构建由 CI 用 -X 注入 tag 版本,以此值与 tag 漂移不可能。
var Version = "0.7.0"
```

- [ ] **Step 4: 改 release.yml**

在 `jobs:` 最前加 test job,并让 `daemon`、`extension` 依赖它;daemon 构建注入版本:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: daemon/go.mod
      - name: Go test (race)
        working-directory: daemon
        run: go test ./... -race -count=1
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: extension/package-lock.json
      - name: Extension tests
        working-directory: extension
        run: |
          npm ci --no-audit --no-fund
          npx vitest run

  daemon:
    needs: test
    runs-on: ubuntu-latest
    # ...matrix 不变...
```

daemon job 的构建行改为:

```yaml
        run: go build -trimpath -ldflags="-s -w -X csi/daemon/internal/version.Version=${GITHUB_REF_NAME#v}" -o out/ ./cmd/csi
```

extension job 加 `needs: test`。`release` job 的 `needs: [daemon, extension]` 不变(传递依赖已覆盖)。

- [ ] **Step 5: 验证**

Run: `cd daemon && go test ./internal/version/ && go build ./...`
Expected: PASS;本地构建版本仍为 0.7.0(`go run ./cmd/csi version` 输出 `csi 0.7.0`)。
另用 `ldflags` 本地验证注入:`go build -ldflags="-X csi/daemon/internal/version.Version=9.9.9" -o /tmp/csi-test ./cmd/csi && /tmp/csi-test version` 输出 `csi 9.9.9`。

- [ ] **Step 6: 提交**

```bash
git add daemon/internal/version/version.go daemon/internal/version/version_test.go .github/workflows/release.yml
git commit -m "release CI 强制跑测试,daemon 版本改 ldflags 注入"
```

---

### Task 2: 版本表面对齐 + CI 守卫

**Files:**
- Create: `scripts/skill-ci/check-versions.mjs`
- Modify: `.github/workflows/skill-ci.yml`
- Modify: `scripts/package-extension.sh`
- Modify: `package.json`(根,0.6.0→0.7.0)、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`.codex-plugin/plugin.json`、`.cursor-plugin/plugin.json`、`.kimi-plugin/plugin.json`(均 0.6.0→0.7.0)

**Interfaces:**
- Produces: `node scripts/skill-ci/check-versions.mjs` — 全部表面一致时退出 0 并打印版本;不一致时逐项打印 diff 退出 1。以 `extension/manifest.json` 的 `version` 为基准。

- [ ] **Step 1: 写对齐检查脚本(先跑确认当前脱节被抓到)**

`scripts/skill-ci/check-versions.mjs`:

```js
#!/usr/bin/env node
// 版本表面对齐闸:daemon version.go / 扩展 manifest+package / 技能 frontmatter / 插件清单 / 根 package.json
// 以 extension/manifest.json 为基准,全部必须相等(退出 1 = 脱节)。
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const read = (p) => readFileSync(`${root}/${p}`, 'utf8');
const json = (p) => JSON.parse(read(p));

const base = json('extension/manifest.json').version;

const surfaces = [
  ['extension/manifest.json', () => json('extension/manifest.json').version],
  ['extension/package.json', () => json('extension/package.json').version],
  ['extension/package-lock.json', () => json('extension/package-lock.json').version],
  ['daemon/internal/version/version.go', () => read('daemon/internal/version/version.go').match(/Version\s*=\s*"([^"]+)"/)?.[1]],
  ['skills/csi/SKILL.md', () => read('skills/csi/SKILL.md').match(/^\s*version:\s*"([^"]+)"/m)?.[1]],
  ['skills/csi-e2e/SKILL.md', () => read('skills/csi-e2e/SKILL.md').match(/^\s*version:\s*"([^"]+)"/m)?.[1]],
  ['package.json', () => json('package.json').version],
  ['.claude-plugin/plugin.json', () => json('.claude-plugin/plugin.json').version],
  ['.claude-plugin/marketplace.json', () => json('.claude-plugin/marketplace.json').plugins?.[0]?.version],
  ['.codex-plugin/plugin.json', () => json('.codex-plugin/plugin.json').version],
  ['.cursor-plugin/plugin.json', () => json('.cursor-plugin/plugin.json').version],
  ['.kimi-plugin/plugin.json', () => json('.kimi-plugin/plugin.json').version],
];

let bad = 0;
for (const [path, get] of surfaces) {
  let v;
  try { v = get(); } catch (e) { console.error(`✗ ${path}: 读取失败 ${e.message}`); bad++; continue; }
  if (v !== base) { console.error(`✗ ${path}: ${v} != ${base}`); bad++; }
  else { console.log(`✓ ${path}: ${v}`); }
}
if (bad) { console.error(`\n${bad} 处版本脱节(基准 ${base})`); process.exit(1); }
console.log(`\nall version surfaces = ${base}`);
```

注意:`.claude-plugin/marketplace.json` 的实际结构执行者先 `cat` 确认版本字段路径(`plugins[0].version` 是推测,按实际结构调整)。

- [ ] **Step 2: 跑脚本确认抓到当前脱节**

Run: `node scripts/skill-ci/check-versions.mjs`
Expected: FAIL,列出 6 处 0.6.0(根 package.json + 5 处插件清单)

- [ ] **Step 3: 修齐脱节表面**

把 Step 2 列出的每处 `0.6.0` 改为 `0.7.0`(逐一编辑,不要全局 sed 误伤依赖版本号;`package-lock.json` 若已 0.7.0 则不动)。

- [ ] **Step 4: package-extension.sh 交叉校验**

在 `scripts/package-extension.sh` 读 dist/manifest.json 版本之后(约 :22)加:

```bash
PKG_VER="$(node -p "require('$ROOT/extension/package.json').version")"
if [ "$VERSION" != "$PKG_VER" ]; then
  echo "manifest.json ($VERSION) 与 package.json ($PKG_VER) 版本不一致" >&2
  exit 1
fi
```

(`$ROOT` 与变量名按文件实际调整;先读该文件再改。)

- [ ] **Step 5: 挂进 skill-ci.yml**

在 `skill-ci.yml` steps 末尾加:

```yaml
      - name: Version surfaces aligned
        run: node scripts/skill-ci/check-versions.mjs
```

- [ ] **Step 6: 验证并提交**

Run: `node scripts/skill-ci/check-versions.mjs && bash -n scripts/package-extension.sh`
Expected: `all version surfaces = 0.7.0`

```bash
git add scripts/skill-ci/check-versions.mjs .github/workflows/skill-ci.yml scripts/package-extension.sh package.json .claude-plugin/ .codex-plugin/ .cursor-plugin/ .kimi-plugin/
git commit -m "版本表面对齐闸:修齐 6 处 0.6.0 脱节,skill-ci 常驻检查"
```

---

### Task 3: 商店合规修复(activeTab + review-notes 漂移)

**Files:**
- Modify: `extension/manifest.json:14`
- Modify: `store/review-notes.md`

- [ ] **Step 1: 确认 activeTab 零使用**

Run: `grep -rn "activeTab" extension/src/`
Expected: 无命中(若意外有命中,停下报告,不要继续删)

- [ ] **Step 2: manifest 删权限**

`extension/manifest.json:14` 改为:

```json
  "permissions": ["tabs", "debugger", "storage", "alarms", "tabGroups", "windows"],
```

- [ ] **Step 3: 修 review-notes.md**

读 `store/review-notes.md` 全文;(a) 删除引用不存在的 `tab-manager.ts` 的 activeTab justification 段落(约 :19);(b) 通篇核对权限清单与 manifest 一致、行为描述与 `docs/protocol.md` §3.4(禁止静默回退)一致,修正漂移处。

- [ ] **Step 4: 验证**

Run: `cd extension && npx vitest run && npm run build`
Expected: 测试全绿,构建成功;`grep activeTab dist/manifest.json` 无命中

- [ ] **Step 5: 提交**

```bash
git add extension/manifest.json store/review-notes.md
git commit -m "商店合规:删零使用的 activeTab,修 review-notes 与实现的漂移"
```

---

## 工作流 B:健壮性修复

### Task 4: WS 写 deadline(daemon)

**Files:**
- Modify: `daemon/internal/ws/hub.go:432-436`
- Test: `daemon/internal/ws/hub_test.go`(沿用现有测试基建;先看该文件的 fake conn 模式)

**Interfaces:**
- Produces: `Hub` 新增字段 `WriteTimeout time.Duration`(导出,默认 0 → 生效值 15s),测试可注入小值。

- [ ] **Step 1: 写失败测试**

测试思路:起一个真 `net.Pipe` 包装的 websocket 连接(或沿用 hub_test.go 现有 fake),对端永不读;`Hub.WriteTimeout = 50 * time.Millisecond`;调 `writeJSON` 应在大约 50ms 返回错误而非永久阻塞。若现有 fake 不支持"不读",用 `httptest.NewServer` + gorilla `Upgrader` 起真 WS,客户端连接后不读,塞满内核缓冲后写超时(内核缓冲较大,测试里把消息体放大到 8MB 确保超过缓冲)。骨架:

```go
func TestWriteJSONDeadline(t *testing.T) {
	// 服务端 upgrade 后不读任何数据
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil { return }
		defer c.Close()
		time.Sleep(5 * time.Second) // 持连接不读
	}))
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil { t.Fatal(err) }
	defer conn.Close()

	h := New("test", log.New(io.Discard, "", 0))
	h.WriteTimeout = 100 * time.Millisecond
	big := make([]byte, 8<<20) // 超过内核写缓冲,逼出写阻塞
	start := time.Now()
	err = h.writeJSON(conn, Message{Type: MsgToolCall, Payload: big})
	if err == nil { t.Fatal("期望写超时错误") }
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("写阻塞 %.1fs,deadline 未生效", d.Seconds())
	}
}
```

- [ ] **Step 2: 跑测试确认失败(阻塞/超时)**

Run: `cd daemon && go test ./internal/ws/ -run TestWriteJSONDeadline -timeout 30s`
Expected: FAIL 或测试超时(err == nil 分支)

- [ ] **Step 3: 实现**

`hub.go`:

```go
// WriteTimeout 单帧写 deadline;0 = 默认 15s(协议 §3.2 上限内任意帧 15s 足够)。
// 对端卡死时防止全局 writeMu 堵死所有 tool_call 与 ping。
WriteTimeout time.Duration
```

```go
func (h *Hub) writeJSON(conn *websocket.Conn, msg Message) error {
	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	timeout := h.WriteTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	_ = conn.SetWriteDeadline(time.Now().Add(timeout))
	return conn.WriteJSON(msg)
}
```

- [ ] **Step 4: 跑全部 ws 测试**

Run: `cd daemon && go test ./internal/ws/ -count=1`
Expected: PASS(含既有 17 个用例)

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/ws/hub.go daemon/internal/ws/hub_test.go
git commit -m "WS 写加 15s deadline,对端卡死不再堵死全局写锁"
```

---

### Task 5: session map 回收(daemon)

**Files:**
- Modify: `daemon/internal/session/session.go`
- Modify: `daemon/internal/session/gate.go`(加 `busy()`)
- Modify: `daemon/internal/server/server.go:103-107`(session 名长度校验)
- Test: `daemon/internal/session/session_test.go`(新建或并入现有)

**Interfaces:**
- Produces: `session.MaxNameLength = 128`、`session.MaxSessions = 256`、`session.IdleTTL = 24h`(均导出常量);`Manager.Now func() time.Time`(nil → time.Now,测试注入)。`fifo` 新增 `busy() bool`。

- [ ] **Step 1: 写失败测试**

`daemon/internal/session/session_test.go` 追加(若已有同名测试文件则并入):

```go
func TestSessionEvictIdleTTL(t *testing.T) {
	m := NewManager()
	now := time.Now()
	m.Now = func() time.Time { return now }
	m.Inject("old", map[string]any{})
	now = now.Add(25 * time.Hour) // 超 IdleTTL
	m.Inject("new", map[string]any{}) // 触发惰性清扫
	for _, n := range m.Names() {
		if n == "old" {
			t.Fatal("闲置超 24h 的 session 未被回收")
		}
	}
}

func TestSessionEvictLRU(t *testing.T) {
	m := NewManager()
	for i := 0; i < MaxSessions; i++ {
		m.Inject(fmt.Sprintf("s%03d", i), map[string]any{})
	}
	m.Inject("s000", map[string]any{}) // 刷新 s000,使它不是最久未用
	m.Inject("overflow", map[string]any{})
	names := m.Names()
	if len(names) > MaxSessions {
		t.Fatalf("session 数 %d 超上限", len(names))
	}
	found := false
	for _, n := range names { if n == "s000" { found = true } }
	if !found { t.Fatal("LRU 误杀了刚访问的 s000") }
	for _, n := range names { if n == "s001" { t.Fatal("最久未用的 s001 应被淘汰") } }
}

func TestSessionEvictSkipsBusy(t *testing.T) {
	m := NewManager()
	now := time.Now()
	m.Now = func() time.Time { return now }
	release, err := m.Acquire(context.Background(), "busy")
	if err != nil { t.Fatal(err) }
	defer release()
	now = now.Add(25 * time.Hour)
	m.Inject("trigger", map[string]any{})
	found := false
	for _, n := range m.Names() { if n == "busy" { found = true } }
	if !found { t.Fatal("持有锁的 session 不能被回收") }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && go test ./internal/session/ -run 'TestSessionEvict' -v`
Expected: FAIL(未回收/字段不存在编译错误)

- [ ] **Step 3: 实现**

`session.go`:

```go
const (
	// MaxSessions session 数上限;超出淘汰最久未访问者(LRU)。
	MaxSessions = 256
	// MaxNameLength session 名长度上限(字符数),防失控客户端刷爆内存。
	MaxNameLength = 128
	// IdleTTL 闲置回收阈值;回收无副作用(session 只持 tab 映射,协议 §3.4 有降级路径)。
	IdleTTL = 24 * time.Hour
)
```

`Session` 加字段 `lastUsed int64`、`lastAccess time.Time`。`Manager` 加 `seq int64` 与 `Now func() time.Time`。`get()` 改造:

```go
func (m *Manager) get(name string) *Session {
	m.seq++
	now := m.now()
	if s, ok := m.sessions[name]; ok {
		s.lastUsed, s.lastAccess = m.seq, now
		if s.gate == nil {
			s.gate = &fifo{}
		}
		return s
	}
	m.sweepLocked(now)
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

// sweepLocked 惰性清扫闲置超 TTL 的 session;持有锁(busy)的跳过。
func (m *Manager) sweepLocked(now time.Time) {
	for n, s := range m.sessions {
		if now.Sub(s.lastAccess) > IdleTTL && !s.gate.busy() {
			delete(m.sessions, n)
		}
	}
}

// evictLRULocked 淘汰最久未访问且未持锁的一个 session。
func (m *Manager) evictLRULocked() {
	var victim string
	var min int64 = math.MaxInt64
	for n, s := range m.sessions {
		if s.gate.busy() {
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
```

`gate.go` 的 `fifo` 加(字段名按实际调整,先读该文件):

```go
// busy 当前是否持有锁(回收扫描跳过持锁 session)。
func (f *fifo) busy() bool {
	return f.held // 按 gate.go 实际实现:锁被持有即 true,可能需要加原子/互斥保护
}
```

注意:`busy()` 与 `LockCtx`/`Unlock` 的并发安全——`get` 在 `m.mu` 下调用 `busy()`,但 `Unlock` 不持 `m.mu`;`held` 需用 `atomic.Bool` 或在 fifo 自己的 mutex 下读写。实现时按 gate.go 现状选最小改动。

`server.go` 的 `handleCommand` 在 `req.Action == ""` 校验后加:

```go
	if len(req.Session) > session.MaxNameLength {
		writeJSON(w, commandResponse{Success: false, Error: fmt.Sprintf("session name too long (max %d)", session.MaxNameLength)})
		return
	}
```

(server.go 需加 `"fmt"` import;错误走 body,不用 400——见 Global Constraints。)

- [ ] **Step 4: 跑全部 session 与 server 测试**

Run: `cd daemon && go test ./internal/session/ ./internal/server/ -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/session/session.go daemon/internal/session/gate.go daemon/internal/session/session_test.go daemon/internal/server/server.go
git commit -m "session map 双闸回收:上限 256 LRU + 闲置 24h,名称限长 128"
```

---

### Task 6: 扩展 WS 断线退避重连(extension)

**Files:**
- Modify: `extension/src/background/ws-client.ts:205-211`(close handler)
- Test: `extension/src/background/ws-client-reconnect.test.ts`(沿用现有 fake WebSocket 模式)

**Interfaces:**
- Produces: `WsClientOptions` 新增可选 `retryDelaysMs?: number[]`(默认 `[1000, 2000, 5000, 10000, 30000]`,封顶取末位),测试注入小值。行为约定:close 后若 desired.shouldConnect 为 true,按退避序列调度 `reconcile()`;收到 `hello_ack` 或手动 `connect()` 成功时重置退避;`disconnect()`(shouldConnect=false)不调度。

- [ ] **Step 1: 写失败测试**

在 `ws-client-reconnect.test.ts` 追加(先读该文件头部,fake WebSocket 与 fake timers 模式照搬):

```ts
it('close 后按退避序列自动重连,不等 reconcile alarm', async () => {
  const client = makeClient({ retryDelaysMs: [10, 20, 40] }); // 按现有 helper 调整
  await client.connect('ws://localhost:1/ws');
  const first = FakeWebSocket.instances[0];
  first.open();
  first.receive({ type: 'hello_ack', payload: { daemonVersion: '0.7.0', tools: [] } });
  first.close(); // 模拟 daemon 重启断开
  expect(FakeWebSocket.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10); // 第一次退避
  expect(FakeWebSocket.instances).toHaveLength(2);
  FakeWebSocket.instances[1].close();
  await vi.advanceTimersByTimeAsync(20);
  expect(FakeWebSocket.instances).toHaveLength(3);
});

it('disconnect() 后不自动重连', async () => {
  // connect → open → disconnect() → 推进所有退避时长 → 无新 socket
});

it('hello_ack 后重置退避序列', async () => {
  // close → 退避一次 → 第二次连接 open + hello_ack → 再 close → 下次延迟回到序列首位
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd extension && npx vitest run src/background/ws-client-reconnect.test.ts`
Expected: FAIL(close 后无新 socket)

- [ ] **Step 3: 实现**

`ws-client.ts` 新增私有成员:

```ts
private retryTimer: ReturnType<typeof setTimeout> | null = null;
private retryAttempt = 0;
private readonly retryDelaysMs: number[];
```

constructor 里 `this.retryDelaysMs = options.retryDelaysMs ?? [1000, 2000, 5000, 10000, 30000];`

close handler 改为:

```ts
socket.addEventListener('close', () => {
  if (this.socket !== socket) return;
  this.socket = null;
  this.setConnectionState('disconnected');
  this.clearConnectingTimer();
  console.log('[ws] disconnected');
  void this.scheduleRetry();
});
```

新方法:

```ts
/** close 后按指数退避自动重连(协议无变更,纯客户端行为);
 *  与 csi-reconcile alarm 共存:alarm 是 30s 兜底,这里是秒级快路径。 */
private async scheduleRetry(): Promise<void> {
  const desired = await this.getDesired();
  if (!desired.shouldConnect || this.retryTimer) return;
  const delays = this.retryDelaysMs;
  const delay = delays[Math.min(this.retryAttempt, delays.length - 1)];
  this.retryAttempt++;
  this.retryTimer = setTimeout(() => {
    this.retryTimer = null;
    void this.reconcile();
  }, delay);
}

private resetRetry(): void {
  this.retryAttempt = 0;
  if (this.retryTimer) {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
```

`handleMessage` 的 `case 'hello_ack'` 里调 `this.resetRetry()`;`disconnect()` 与 `teardown()` 里也要 `this.resetRetry()`(手动断开不留下挂起的重试)。

- [ ] **Step 4: 跑全部 ws-client 测试**

Run: `cd extension && npx vitest run src/background/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add extension/src/background/ws-client.ts extension/src/background/ws-client-reconnect.test.ts
git commit -m "扩展断线退避重连:close 后 1s→30s 指数退避,不等 30s alarm"
```

---

### Task 7: popup 显示 daemon 版本 + 错配警告(extension)

**Files:**
- Modify: `extension/src/shared/messages.ts`(`StatusResponse` 加字段)
- Modify: `extension/src/background/ws-client.ts`(存 hello_ack 的 daemonVersion)
- Modify: `extension/src/background/index.ts`(GET_STATUS 应答带上)
- Modify: `extension/popup.html:30` 附近、`extension/src/popup/popup.ts:29-31`
- Modify: `extension/_locales/en/messages.json`、`extension/_locales/zh_CN/messages.json`
- Test: `extension/src/popup/popup.test.ts`、`extension/src/background/index.test.ts`(均为现有文件)

**Interfaces:**
- Consumes: Task 6 的 `resetRetry` 挂点(hello_ack case)。
- Produces: `StatusResponse` 新增 `daemonVersion?: string`;`WsClient` 新增 `getDaemonVersion(): string`。popup 渲染规则:footer 显示 `ext X.Y.Z · daemon A.B.C`;major.minor 不一致时追加 i18n 警告文案。

- [ ] **Step 1: 写失败测试**

`index.test.ts`:模拟 hello_ack 带 `daemonVersion: '0.7.0'` 后,`GET_STATUS` 应答含 `daemonVersion: '0.7.0'`。
`popup.test.ts`:GET_STATUS 返回 `{ state:'connected', serverUrl:'...', daemonVersion:'0.6.0' }` 且 manifest 版本 0.7.0 时,footer 文本含警告 key 对应文案(测试里 i18n mock 直接返回 key,断言 `versionMismatch`)。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd extension && npx vitest run src/background/index.test.ts src/popup/popup.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`messages.ts` 的 `StatusResponse` 加 `daemonVersion?: string;`;新增 `export interface HelloAckPayload { daemonVersion?: string; tools?: string[]; }`。

`ws-client.ts`:加 `private daemonVersion = '';` 与 `getDaemonVersion(): string { return this.daemonVersion; }`;`hello_ack` case:

```ts
case 'hello_ack': {
  const ack = message.payload as HelloAckPayload | undefined;
  this.daemonVersion = ack?.daemonVersion ?? '';
  this.resetRetry();
  break;
}
```

`index.ts` 的 `GET_STATUS` handler 应答对象加 `daemonVersion: wsClient.getDaemonVersion()`(变量名按 index.ts 实际)。

`popup.html` footer 保持单元素;`popup.ts` 的 `applyStaticTexts` 改为存 manifest 版本到模块变量,新增:

```ts
function renderVersion(daemonVersion?: string): void {
  const ext = chrome.runtime.getManifest().version;
  let text = i18n('versionFooter', ext);
  if (daemonVersion) {
    text += ` · daemon ${daemonVersion}`;
    const mm = (v: string) => v.split('.').slice(0, 2).join('.');
    if (mm(ext) !== mm(daemonVersion)) text += ` — ${i18n('versionMismatch')}`;
  }
  document.getElementById('version-footer')!.textContent = text;
}
```

`refreshStatus` / `CONNECTION_STATE_CHANGED` 路径把 `daemonVersion` 传给 `renderVersion`;`applyStaticTexts` 里初始调 `renderVersion()`。

i18n(`en` 与 `zh_CN` 都加):
- en: `"versionMismatch": { "message": "version mismatch with daemon — update CSI" }`
- zh_CN: `"versionMismatch": { "message": "与 daemon 版本不匹配,请更新 CSI" }`

- [ ] **Step 4: 跑测试 + 构建**

Run: `cd extension && npx vitest run && npm run build`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add extension/src/shared/messages.ts extension/src/background/ws-client.ts extension/src/background/index.ts extension/popup.html extension/src/popup/popup.ts extension/_locales/ extension/src/popup/popup.test.ts extension/src/background/index.test.ts
git commit -m "popup 显示 daemon 版本,major.minor 不匹配出警告"
```

---

## 工作流 C:更新机制

### Task 8: update 包——latest 检查 + 缓存(daemon)

**Files:**
- Create: `daemon/internal/update/update.go`
- Test: `daemon/internal/update/update_test.go`

**Interfaces:**
- Produces(后续任务依赖的精确签名):

```go
package update

type CheckResult struct {
	LatestVersion string    `json:"latest_version"` // 去 v 前缀,如 "0.8.0"
	Tag           string    `json:"tag"`            // 如 "v0.8.0"
	CheckedAt     time.Time `json:"checked_at"`
}

// Checker 查询 GitHub latest release 并缓存到 <Dir>/update-check.json(TTL 24h)。
type Checker struct {
	Dir      string        // ~/.csi
	APIURL   string        // 默认 https://api.github.com/repos/ximing/csi/releases/latest,测试注入
	Releases string        // 下载基址,默认 https://github.com/ximing/csi/releases
	Client   *http.Client  // nil → 10s 超时的默认 client
	Now      func() time.Time // nil → time.Now
}

func (c *Checker) Check(ctx context.Context, force bool) (*CheckResult, error)           // 缓存新鲜(24h)且不 force 时直接读缓存
func (c *Checker) ReadCache() *CheckResult                                               // 无缓存返回 nil
func NewerAvailable(current, latest string) bool                                         // semver x.y.z 比较,解析失败 → false
```

- [ ] **Step 1: 写失败测试**

```go
func TestCheckCachesResult(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		fmt.Fprint(w, `{"tag_name":"v0.8.0"}`)
	}))
	defer srv.Close()
	dir := t.TempDir()
	c := &Checker{Dir: dir, APIURL: srv.URL}
	r1, err := c.Check(context.Background(), false)
	if err != nil { t.Fatal(err) }
	if r1.LatestVersion != "0.8.0" || r1.Tag != "v0.8.0" { t.Fatalf("bad result: %+v", r1) }
	// 第二次不 force:命中缓存,不再打 API
	if _, err := c.Check(context.Background(), false); err != nil { t.Fatal(err) }
	if hits != 1 { t.Fatalf("期望 1 次 API 调用,实际 %d", hits) }
	// force 绕过缓存
	if _, err := c.Check(context.Background(), true); err != nil { t.Fatal(err) }
	if hits != 2 { t.Fatalf("force 后期望 2 次,实际 %d", hits) }
}

func TestCheckCacheTTLExpired(t *testing.T) { /* 注入 Now,把 CheckedAt 推到 25h 前,不 force 也应重新请求 */ }

func TestNewerAvailable(t *testing.T) {
	cases := []struct{ cur, lat string; want bool }{
		{"0.7.0", "0.8.0", true}, {"0.7.0", "0.7.0", false}, {"0.7.0", "0.6.9", false},
		{"0.7.0", "garbage", false}, {"0.7", "0.7.1", true}, {"1.0.0", "0.9.9", false},
	}
	for _, c := range cases {
		if got := NewerAvailable(c.cur, c.lat); got != c.want {
			t.Errorf("NewerAvailable(%q,%q)=%v want %v", c.cur, c.lat, got, c.want)
		}
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && go test ./internal/update/`
Expected: 编译错误(包不存在)

- [ ] **Step 3: 实现 `update.go`**

要点(Go 标准库):
- `Check`:非 force 时 `ReadCache`,缓存存在且 `now.Sub(CheckedAt) < 24h` 直接返回;否则 GET APIURL(`Accept: application/vnd.github+json`,`User-Agent: csi-daemon`),解析 `{"tag_name": "vX.Y.Z"}`,去 `v` 前缀得 `LatestVersion`;写缓存(先写 tmp 再 rename,原子);API 失败但有过期缓存 → 返回过期缓存 + nil error(离线不打扰),无缓存才返回 error。
- `NewerAvailable`:按 `.` split 逐段 atoi 比较,段数不足补 0;任何一段非数字 → false。
- 常量导出:`CacheTTL = 24 * time.Hour`、`DefaultAPIURL`、`DefaultReleases`。

- [ ] **Step 4: 跑测试**

Run: `cd daemon && go test ./internal/update/ -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/update/update.go daemon/internal/update/update_test.go
git commit -m "update 包:GitHub latest 检查 + 24h 缓存 + semver 比较"
```

---

### Task 9: update 包——下载/校验/替换(daemon)

**Files:**
- Create: `daemon/internal/update/download.go`
- Test: `daemon/internal/update/download_test.go`

**Interfaces:**
- Consumes: Task 8 的 `Checker`(用 `c.Releases` 拼下载 URL)。
- Produces:

```go
// Fetch 下载 <Releases>/download/<tag>/ 下对应平台的 daemon 包与 checksums.txt,
// 校验 sha256 后解出二进制,返回临时文件路径(调用方负责清理或消费)。
func (c *Checker) Fetch(ctx context.Context, tag, goos, goarch string) (binPath string, err error)

// Replace 用 newBin 替换 self(当前可执行文件),返回备份路径。
// unix:tmp+rename 原子覆盖;windows:先 rename 现行为 self+".old" 再落新文件。
// 备份只留一代:<self>.bak。
func Replace(self, newBin string) (backupPath string, err error)

// IsHomebrewInstall 判断二进制是否 Homebrew 安装(Cellar/homebrew/linuxbrew 路径)。
func IsHomebrewInstall(self string) bool
```

- [ ] **Step 1: 写失败测试**

```go
func TestFetchVerifiesChecksum(t *testing.T) {
	// httptest 伺服:构造真 tar.gz(内含名为 csi 的文件)、真 checksums.txt
	// 1) checksum 匹配 → 返回的二进制路径可读,内容与打包内容一致
	// 2) 篡改 checksums.txt → 返回错误,且不产出二进制
}

func TestFetchAssetName(t *testing.T) {
	// windows+amd64 → 请求路径含 csi-windows-amd64.zip;darwin+arm64 → csi-darwin-arm64.tar.gz
	// 不支持的组合(linux+mips)→ 错误
}

func TestReplaceUnix(t *testing.T) {
	if runtime.GOOS == "windows" { t.Skip("unix 路径") }
	dir := t.TempDir()
	self := filepath.Join(dir, "csi")
	os.WriteFile(self, []byte("old"), 0o755)
	nb := filepath.Join(dir, "new")
	os.WriteFile(nb, []byte("new"), 0o755)
	bak, err := Replace(self, nb)
	if err != nil { t.Fatal(err) }
	data, _ := os.ReadFile(self)
	if string(data) != "new" { t.Fatal("替换未生效") }
	if b, _ := os.ReadFile(bak); string(b) != "old" { t.Fatal("备份缺失") }
	// 可执行位保留
	fi, _ := os.Stat(self)
	if fi.Mode()&0o100 == 0 { t.Fatal("可执行位丢失") }
}

func TestIsHomebrewInstall(t *testing.T) {
	if !IsHomebrewInstall("/opt/homebrew/Cellar/csi/0.7.0/bin/csi") { t.Error("Cellar 未识别") }
	if IsHomebrewInstall("/Users/x/.csi/bin/csi") { t.Error("误报") }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && go test ./internal/update/ -run 'TestFetch|TestReplace|TestIsHomebrew'`
Expected: 编译错误

- [ ] **Step 3: 实现 `download.go`**

要点:
- asset 名:`windows/amd64 → csi-windows-amd64.zip`;其余 `csi-<goos>-<goarch>.tar.gz`;白名单矩阵外的组合报错(darwin/arm64、darwin/amd64、linux/arm64、linux/amd64、windows/amd64)。
- 下载顺序:`checksums.txt` → asset;`sha256.New()` 边下边算或下完算;与 checksums.txt 中该 asset 的行匹配,不匹配 → 错误并清理。
- 解包:tar.gz 用 `archive/tar`+`gzip` 取名为 `csi` 的成员;zip 用 `archive/zip` 取 `csi.exe`;落到 `os.MkdirTemp` 里。
- `Replace`:unix 走 `os.Rename(self, self+".bak")` 失败不致命 → 然后 `os.Rename(newBin, self)`(跨设备时 fallback 到 copy);windows 走 rename-to-`.old` + copy-into-place(注释说明 Windows 不能覆盖运行中的 exe,但允许 rename)。权限位显式 `Chmod(0o755)`。
- `IsHomebrewInstall`:`strings.Contains` 匹配 `/Cellar/`、`/homebrew/`、`/linuxbrew/`(大小写不敏感)。

- [ ] **Step 4: 跑测试**

Run: `cd daemon && go test ./internal/update/ -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/update/download.go daemon/internal/update/download_test.go
git commit -m "update 包:下载 + sha256 校验 + 平台感知替换(含 .bak 备份)"
```

---

### Task 10: `csi update` 子命令(daemon CLI)

**Files:**
- Modify: `daemon/cmd/csi/main.go`(注册命令 + usage)
- Create: `daemon/cmd/csi/update.go`
- Test: `daemon/cmd/csi/update_test.go`

**Interfaces:**
- Consumes: Task 8/9 的 `Checker.Check/Fetch`、`update.Replace`、`update.IsHomebrewInstall`、`update.NewerAvailable`;`commands.go` 的 `fetchStatus`、`startDaemon`。
- Produces: `runUpdate(args []string, deps updateDeps) error` —— 可注入依赖(检查器、可执行路径、重启函数)以便测试;`cmdUpdate()` 为薄壳。旗标:`--check`、`--quiet`、`--with-skills`、`--with-extension`。

- [ ] **Step 1: 写失败测试**

```go
func TestUpdateAlreadyLatest(t *testing.T) {
	// deps.Check 返回 latest=当前版本 → 输出 "already up to date",不调 Fetch/Replace/Restart
}
func TestUpdateFlow(t *testing.T) {
	// latest 更新 → Fetch 被调 → Replace 被调 → daemon 在跑(deps.Running=true)→ Restart 被调
	// daemon 没在跑 → 不 Restart
}
func TestUpdateHomebrewRefused(t *testing.T) {
	// IsHomebrew=true → 错误文案含 "brew upgrade",不动任何文件
}
func TestUpdateCheckOnly(t *testing.T) {
	// --check:有新版也只打印,不 Fetch
}
```

`updateDeps` 定义(实现时照此):

```go
type updateDeps struct {
	Self       func() (string, error)              // 默认 os.Executable
	IsHomebrew func(string) bool
	Check      func(ctx context.Context, force bool) (*update.CheckResult, error)
	Fetch      func(ctx context.Context, tag, goos, goarch string) (string, error)
	Replace    func(self, newBin string) (string, error)
	Running    func() bool                          // pid+healthz 判定,复用 fetchStatus
	Restart    func() error                         // 默认走 POST /restart,失败回退 cmdRestart 逻辑
	Out        io.Writer
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && go test ./cmd/csi/ -run TestUpdate`
Expected: 编译错误

- [ ] **Step 3: 实现**

`update.go` 流程(与 spec C1 一致):

1. 解析旗标(未知旗标报错)。
2. `Self()` → `IsHomebrew` → 拒绝并提示 `brew upgrade`。
3. `Check(ctx, false)`;`--check` 时打印 `current`/`latest`/`update_available` 后返回。
4. `NewerAvailable(version.Version, latest)` 为否 → 打印 `csi is already up to date (x.y.z)` 返回。
5. `Fetch` → `Replace(self, bin)` → 打印备份路径。
6. `Running()` → `Restart()`;未运行 → 提示下次 start 生效。
7. `--with-skills` / `--with-extension`:从 `<Releases>/download/<tag>/` 下载对应包,技能解到 `~/.claude/skills/`(与 install.sh 同布局,覆盖前打印警告),扩展解到 `~/.csi/extension` 并打印 "到 chrome://extensions 点 reload"。**只在显式传旗标时执行。**
8. `--quiet`:正常路径不输出;错误仍写 stderr 并返回非零(定时任务靠日志)。

`main.go`:`case "update": err = cmdUpdate()`;usage 加 `update          update daemon to the latest release (--check|--quiet|--with-skills|--with-extension)`。

- [ ] **Step 4: 跑测试 + 本地手测**

Run: `cd daemon && go test ./cmd/csi/ && go build -o /tmp/csi-u ./cmd/csi && /tmp/csi-u update --check`
Expected: PASS;`--check` 在真机上打到 GitHub 输出当前/latest

- [ ] **Step 5: 提交**

```bash
git add daemon/cmd/csi/update.go daemon/cmd/csi/update_test.go daemon/cmd/csi/main.go
git commit -m "新增 csi update:检查/下载/校验/替换/优雅重启一条龙"
```

---

### Task 11: `/status` 暴露更新信息 + 启动异步检查(daemon)

**Files:**
- Modify: `daemon/internal/server/server.go`(`statusResponse` + `handleStatus`)
- Modify: `daemon/cmd/csi/commands.go`(`cmdServe` 启动后异步检查)
- Test: `daemon/internal/server/server_test.go`

**Interfaces:**
- Consumes: Task 8 的 `update.Checker`。
- Produces: `/status` 响应新增 `update_available: bool`、`latest_version: string`(仅在有缓存时出现,`omitempty`);`Server` 新增导出字段 `UpdateChecker *update.Checker`(nil → 不输出新字段)。

- [ ] **Step 1: 写失败测试**

```go
func TestStatusUpdateFields(t *testing.T) {
	// 构造 Server,UpdateChecker.Dir 指向预置了 update-check.json 的临时目录
	// 缓存 latest=9.9.9 → GET /status 含 update_available:true, latest_version:"9.9.9"
	// 无缓存 → 响应无这两个字段
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && go test ./internal/server/ -run TestStatusUpdateFields`
Expected: FAIL

- [ ] **Step 3: 实现**

`statusResponse` 加:

```go
	UpdateAvailable *bool  `json:"update_available,omitempty"`
	LatestVersion   string `json:"latest_version,omitempty"`
```

`handleStatus` 里:

```go
	if s.UpdateChecker != nil {
		if cache := s.UpdateChecker.ReadCache(); cache != nil {
			ua := update.NewerAvailable(version.Version, cache.LatestVersion)
			resp.UpdateAvailable = &ua
			resp.LatestVersion = cache.LatestVersion
		}
	}
```

(把 `writeJSON(w, statusResponse{...})` 重构为先构造 `resp` 再按需补字段。)

`commands.go` 的 `cmdServe` 在 `logger.Printf("csi %s serving ...")` 后加:

```go
	srv.UpdateChecker = &update.Checker{Dir: dir}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if _, err := srv.UpdateChecker.Check(ctx, false); err != nil {
			logger.Printf("update check: %v", err)
		}
	}()
```

- [ ] **Step 4: 跑测试**

Run: `cd daemon && go test ./internal/server/ ./cmd/csi/ -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/server/server.go daemon/internal/server/server_test.go daemon/cmd/csi/commands.go
git commit -m "/status 暴露 update_available/latest_version,启动时异步检查更新"
```

---

### Task 12: autostart 每日更新定时任务(daemon)

**Files:**
- Modify: `daemon/internal/autostart/generate.go`(新增三平台定时单元生成)
- Modify: `daemon/internal/autostart/apply.go`(Enable/Disable 一并注册/移除)
- Test: `daemon/internal/autostart/*_test.go`(现有测试模式:纯字符串断言 + fake runCmd)

**Interfaces:**
- Consumes: Task 10 的 `csi update --quiet`。
- Produces:

```go
func DarwinUpdatePlist(exe string, minute int) string   // Label ai.csi.update,StartCalendarInterval 每日 04:minute
func LinuxUpdateTimer(exe string, minute int) (timer, service string) // csi-update.timer + csi-update.service
func WindowsUpdateTaskCommand(exe string, minute int) []string        // schtasks 参数
func UpdateMinute() int  // 0-59 的稳定随机:取 identity/PID 文件不可行,用 sha256(home) 派生,保证同机同值
```

定时命令语义:`csi start`(幂等探活)然后 `csi update --quiet`。

- [ ] **Step 1: 写失败测试**

```go
func TestDarwinUpdatePlist(t *testing.T) {
	p := DarwinUpdatePlist("/Users/x/.csi/bin/csi", 37)
	for _, want := range []string{"ai.csi.update", "StartCalendarInterval", "<integer>4</integer>", "<integer>37</integer>", "/bin/sh", "start", "update"} {
		if !strings.Contains(p, want) { t.Errorf("plist 缺 %q", want) }
	}
	if strings.Contains(p, "KeepAlive") { t.Error("禁止 KeepAlive") }
}
func TestLinuxUpdateTimer(t *testing.T) {
	timer, service := LinuxUpdateTimer("/home/x/.csi/bin/csi", 5)
	if !strings.Contains(timer, "OnCalendar=*-*-* 04:05:00") { t.Error(timer) }
	if !strings.Contains(timer, "Persistent=true") { t.Error("漏 Persistent") }
	if !strings.Contains(service, "Type=oneshot") { t.Error(service) }
	if strings.Contains(service, "Restart=") { t.Error("禁止 Restart=") }
}
func TestUpdateMinuteStable(t *testing.T) {
	if UpdateMinute() != UpdateMinute() { t.Error("必须稳定") }
	if m := UpdateMinute(); m < 0 || m > 59 { t.Error("越界") }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && go test ./internal/autostart/`
Expected: 编译错误

- [ ] **Step 3: 实现**

`generate.go` 追加(常量:`DarwinUpdateLabel = "ai.csi.update"`,文件名 `ai.csi.update.plist`,linux `csi-update.timer`/`csi-update.service`,windows 任务名 `CSI-Update`):

- darwin plist:`ProgramArguments` = `/bin/sh -c '"<exe>" start && "<exe>" update --quiet'`(拆三个 string);`StartCalendarInterval` dict 含 `Hour=4`、`Minute=<minute>`;`RunAtLoad=false`(不写该 key)。
- linux:`csi-update.timer`(`[Timer] OnCalendar=*-*-* 04:%02d:00`、`Persistent=true`、`[Install] WantedBy=timers.target`)+ `csi-update.service`(oneshot,`ExecStart=/bin/sh -c '"<exe>" start && "<exe>" update --quiet'`)。
- windows:`schtasks /Create /F /SC DAILY /ST 04:%02d /TN CSI-Update /TR "cmd /c \"\"<exe>\" start && \"<exe>\" update --quiet\""`——参数切片形式返回,注释说明引号嵌套。
- `UpdateMinute()`:`sum := sha256.Sum256([]byte(home)); return int(sum[0]) % 60`(home 从 `os.UserHomeDir`;注入点:包级 `var homeDir = os.UserHomeDir` 或直接读环境,测试可接受同机稳定即可)。

`apply.go`:`Enable` 成功后在各平台追加注册(darwin:写第二个 plist + `launchctl bootstrap`;linux:写两个文件 + `daemon-reload` + `enable --now csi-update.timer`;windows:`schtasks /Create`);`Disable` 对称移除(bootout/删文件、`disable`+删两文件、`schtasks /Delete /F`)。注册失败只降级为 error 返回(调用方 cmdAutostart 已会报错);**但注意 install.sh 对 autostart 失败仅 warn,不会因定时任务注册失败搞挂安装**。

`Enabled`/`FormatStatus` 不动(定时任务不单独报状态)。

- [ ] **Step 4: 跑测试 + 真机验证(macOS)**

Run: `cd daemon && go test ./internal/autostart/ -v && go build -o ~/.csi/bin/csi ./cmd/csi && ~/.csi/bin/csi autostart off && ~/.csi/bin/csi autostart on && cat ~/Library/LaunchAgents/ai.csi.update.plist`
Expected: PASS;plist 存在且含 StartCalendarInterval;验证完 `autostart on` 恢复常态

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/autostart/generate.go daemon/internal/autostart/apply.go daemon/internal/autostart/
git commit -m "autostart 增加每日更新定时任务:csi start 探活 + csi update --quiet"
```

---

### Task 13: 安装器升级语义修复(sh + ps1 parity)

**Files:**
- Modify: `scripts/install.sh`
- Modify: `scripts/install.ps1`

**Interfaces:**
- Consumes: Task 10 的 `csi update`(安装器不直接调它,仍走 Release 下载)、`csi restart` 现有幂等性。

- [ ] **Step 1: install.sh 改动**

a) 开头(detect OS/arch 后)记录升级前状态:

```bash
WAS_RUNNING=0
if [ -x "$BIN_PATH" ] && curl -sf --max-time 2 "http://127.0.0.1:${CSI_PORT:-10088}/healthz" >/dev/null 2>&1; then
  WAS_RUNNING=1
fi
```

b) daemon 下载后加 sha256 校验(`download` 函数可复用):

```bash
download "$DL/checksums.txt" "$TMP_DIR/checksums.txt"
( cd "$TMP_DIR" && grep "csi-$OS-$ARCH.tar.gz" checksums.txt | shasum -a 256 -c - ) \
  || die "checksum mismatch: csi-$OS-$ARCH.tar.gz"
```

扩展 zip 与技能包同样校验(同一 checksums.txt,grep 对应文件名)。Linux 有 `sha256sum`,macOS 只有 `shasum`;统一用 `shasum -a 256`(Linux 发行版自带 perl shasum;若无则 fallback `sha256sum`,实现一个 `sha256_check()` 封装先试 `shasum` 再试 `sha256sum`)。

c) 第 5 步改为升级语义:

```bash
if [ "$WAS_RUNNING" -eq 1 ]; then
  "$BIN_PATH" restart && ok "daemon restarted on new version" || warn "..."
else
  "$BIN_PATH" start && ok "..." || warn "daemon failed to start — check logs at $INSTALL_DIR/logs/ (daemon-<date>.log)"
fi
```

顺带把 :295 的 `daemon.log` 文件名修掉(见上)。

d) 结束段落前落版本文件:

```bash
"$BIN_PATH" version 2>/dev/null | awk '{print $2}' > "$INSTALL_DIR/VERSION" || true
```

- [ ] **Step 2: install.ps1 对称改动**

先读 `install.ps1` 全文,按同一语义改:
a) 记录 `$script:WasRunning`(替换前 `csi.exe status` 或 healthz 探测)。
b) 下载 `checksums.txt`,`Get-FileHash -Algorithm SHA256` 比对每个包,不符 `throw`。
c) 替换运行中的 `csi.exe` 前 `& $BinPath stop`,替换后 `$WasRunning` 则 `start` 否则 `start`(stop 后必然不在跑;直接 `start` 即可,但输出文案区分"restarted on new version")。
d) 落 `$InstallDir\VERSION`。
e) 检查 ps1 的日志文件名提示是否也有 `daemon.log` 旧名,一并修。

- [ ] **Step 3: 验证**

Run: `bash -n scripts/install.sh`;本机真跑 `CSI_VERSION=latest bash scripts/install.sh --no-skill -y`(会重装本机 daemon,属预期)
Expected: 语法通过;实跑输出含 checksum 校验通过、daemon restarted on new version;`cat ~/.csi/VERSION` 有版本号

- [ ] **Step 4: 提交**

```bash
git add scripts/install.sh scripts/install.ps1
git commit -m "安装器:sha256 校验、升级后自动 restart、落 VERSION 文件、修日志名"
```

---

### Task 14: `csi uninstall` 子命令(daemon)

**Files:**
- Modify: `daemon/cmd/csi/main.go`(注册 + usage)
- Create: `daemon/cmd/csi/uninstall.go`
- Test: `daemon/cmd/csi/uninstall_test.go`

**Interfaces:**
- Consumes: `stopDaemon`、`autostart.Disable`、Task 12 的定时任务移除。
- Produces: `runUninstall(args []string, deps uninstallDeps) error`(可注入,同 Task 10 模式);旗标 `-y/--yes`。

- [ ] **Step 1: 写失败测试**

```go
func TestUninstallFlow(t *testing.T) {
	// deps:confirm=true → 依次调 Stop、DisableAutostart、RemoveAll(dir);输出提示技能/扩展手动清理
}
func TestUninstallDeclined(t *testing.T) {
	// confirm=false → 无任何副作用,输出 "aborted"
}
func TestUninstallYesFlag(t *testing.T) {
	// -y 跳过确认
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && go test ./cmd/csi/ -run TestUninstall`
Expected: 编译错误

- [ ] **Step 3: 实现**

流程:
1. 解析 `-y`;非 `-y` 时 stderr 打印将删除的内容,从 `/dev/tty`(unix;windows 直接 stdin)读确认。
2. `stopDaemon(dir, false)`(没在跑不报错)。
3. `autostart.Disable(home)`(含 Task 12 的定时任务移除)。
4. windows 自删问题:unix 直接 `os.RemoveAll(dir)`;windows 不能删运行中的自身 exe——spawn `cmd /c "ping 127.0.0.1 -n 3 > nul & rmdir /s /q <dir>"` 脱离进程后立即返回,输出说明目录将在数秒后删除。
5. 输出引导:技能目录(`~/.claude/skills/csi`、`csi-e2e` 及其它 agent 目录)与 Chrome 扩展(CWS 或 load unpacked)需手动删,打印路径与 `chrome://extensions`。

`main.go`:`case "uninstall": err = cmdUninstall()`;usage 加 `uninstall [-y]   stop daemon, remove autostart and ~/.csi`。

- [ ] **Step 4: 跑测试**

Run: `cd daemon && go test ./cmd/csi/ -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add daemon/cmd/csi/uninstall.go daemon/cmd/csi/uninstall_test.go daemon/cmd/csi/main.go
git commit -m "新增 csi uninstall:停 daemon、撤自启与定时任务、清 ~/.csi"
```

---

### Task 15: 文档——README 升级/卸载章节 + 技能 operations.md

**Files:**
- Modify: `README.md`、`README.zh-CN.md`
- Modify: `skills/csi/references/operations.md`

- [ ] **Step 1: 读现有结构**

读 `README.md` 与 `README.zh-CN.md` 的安装章节,确定插入位置(安装之后、FAQ/开发之前);读 `operations.md` 全文。

- [ ] **Step 2: README 双语加「升级」节**

内容要点(双语各自成文,不要机翻味):
- 三条通道:`curl -fsSL .../install.sh | bash`(幂等,即升级;Windows 给 ps1 命令)/ `csi update`(daemon 单独更新)/ `brew upgrade csi`(brew 用户)。
- 自动更新说明:安装时注册的每日定时任务会探活并自更新 daemon;`csi autostart off` 一并关闭;手动触发 `csi update --check` 查看。
- sideload 扩展:重跑安装器或 `csi update --with-extension` 后到 `chrome://extensions` reload;CWS 用户由 Chrome 自动更新。
- 技能包:`csi update --with-skills` 或重跑安装器。

- [ ] **Step 3: README 双语加「卸载」节**

`csi uninstall` + 手动清理技能目录与 Chrome 扩展的说明。

- [ ] **Step 4: operations.md 修订**

a) :47 附近对不存在 `uninstall` 命令的引用改为真实 `csi uninstall`(语义保留:不要自动运行)。
b) Recovery 段加一条:排查时 `curl -s http://127.0.0.1:10088/status` 看 `update_available`,为 true 时建议用户跑 `csi update`(列入 "Do NOT do automatically" 清单——更新涉及替换二进制与重启,由用户决策)。

- [ ] **Step 5: 提交**

```bash
git add README.md README.zh-CN.md skills/csi/references/operations.md
git commit -m "文档:README 升级/卸载章节,operations.md 接真实 uninstall 与 update_available"
```

---

## 收尾验证(所有任务完成后)

- [ ] `cd daemon && go test ./... -race -count=1` 全绿
- [ ] `cd extension && npx vitest run && npm run build` 全绿
- [ ] `node scripts/skill-ci/check-versions.mjs` 通过
- [ ] 真机链路:`go build -o ~/.csi/bin/csi ./cmd/csi` → `csi restart` → 扩展 popup 显示 connected 且 footer 有 daemon 版本 → `csi update --check` 输出正常 → `ls ~/Library/LaunchAgents/ai.csi.update.plist` 存在
- [ ] spec 对照:工作流 A/B/C 每项都能在 commit 历史里指到
