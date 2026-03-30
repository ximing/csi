# 0.4.0 Agent 可靠性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地规格 0.4.0：compact YAML snapshot、`wait` / `scroll` / `hover`、`screenshot.fullPage`、hello.tools 版本握手。工具数 17 → 20。

**Architecture:** 协议先改。YAML 在扩展里压完再过 WS。新工具在扩展内执行（`wait` 在 SW 里轮询，不让 daemon/技能轮询）。daemon 在转发前用扩展 hello 上报的 `tools[]` 改写「请升级扩展」错误；旧扩展不报 `tools` 时视为 0.3.0 的 17 件套。

**Tech Stack:** 现有 Go daemon + TypeScript MV3 扩展。不加依赖、不加测试跑器。

**Spec:** `docs/superpowers/specs/2026-03-30-agent-reliability-design.md`（已确认）。**本计划只做 0.4.0。** 0.5 开机自启、0.6 iframe/对话框/下载另开计划，禁止顺手做。

## Global Constraints

- 协议先行：先改 `docs/protocol.md`，再改实现。四处清单同一发版结束时必须一致：protocol §4、`validTools`、MCP `toolDefs`、扩展 registry、`skills/csi/SKILL.md` 表。
- `_` 前缀字段只由 daemon 注入。本计划不新增 `_` 字段。
- 业务错误放 HTTP 200 body 的 `error`。`does not implement` 这句英文是技能稳定匹配串，不要翻译、不要改用词。
- 提交回填虚构日期（`GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`，+08:00），各 Task 已写死时刻。信息中文随意风格。禁止用真实当天日期。
- 不改安全边界（只绑 `127.0.0.1`，无鉴权）。不加 `sleep`、不做 `networkidle`、不穿透 iframe、不申请 `downloads` 权限。
- daemon 改完：`cd daemon && go test ./... && go vet ./...`。扩展改完：`cd extension && npm run typecheck && npm run build`。
- 版本号留到 Task 10 一次性改 0.4.0。中间 commit 保持 0.3.0，避免半套版本。
- snapshot 默认形状变化是破坏性的：YAML 必须在扩展里生成。`mode=full` 保持今天的 JSON 数组。

## File map

| 文件 | 职责 |
|---|---|
| `docs/protocol.md` | 契约：hello.tools、/status.extension_tools、snapshot/screenshot 新参数、wait/scroll/hover |
| `extension/src/background/tools/ax-yaml.ts` | 新建。AX → CompactNode → YAML 纯函数 |
| `extension/src/background/tools/snapshot.ts` | mode / selector / max_chars；compact 走 ax-yaml |
| `extension/src/background/tools/wait.ts` | 新建。扩展内轮询 |
| `extension/src/background/tools/scroll.ts` | 新建 |
| `extension/src/background/tools/hover.ts` | 新建。mouseMoved only |
| `extension/src/background/tools/screenshot.ts` | `fullPage` |
| `extension/src/background/registry.ts` | 注册 3 个工具 + `toolNames()` |
| `extension/src/shared/messages.ts` | `HelloPayload.tools` |
| `extension/src/background/ws-client.ts` | hello 带 tools |
| `daemon/internal/ws/hub.go` | 解析并保存扩展 tools；hello_ack 带回 daemon tools |
| `daemon/internal/tools/tools.go` | validTools + `toolSince` + Inventory 检查 |
| `daemon/internal/tools/tools_test.go` | 新建。改写逻辑单测 |
| `daemon/internal/mcp/tools.go` | 3 个新工具 + snapshot/screenshot schema |
| `daemon/internal/server/server.go` | `/status.extension_tools`；Executor.Inventory = Hub |
| `skills/csi/SKILL.md` 等 | 表 20 行；wait 替换轮询首选 |

---

### Task 1: 协议 0.4.0 契约

**Files:**
- Modify: `docs/protocol.md`
- Modify: `docs/superpowers/specs/2026-03-30-agent-reliability-design.md`（状态已改「已确认」，随本任务一起提交）

**Interfaces:**
- Produces: 下文即实现必须遵守的形状。后续任务禁止另起字段名。

- [ ] **Step 1: 改 §3.3 消息表**

`hello` payload 改为 `{extensionVersion, tools?}`。`hello_ack` 改为 `{daemonVersion, tools}`。

在表下补三句：

- `tools` 为工具名字符串数组。扩展发自己 registry 的全部键；缺省该字段（0.3.0 及更早）视为 0.3.0 的 17 件套。
- daemon 的 `hello_ack.tools` 为当前 `validTools`（排序后）。
- 扩展缺某个已调用工具时，daemon **不转发**，返回
  `extension <ver> does not implement "<name>" (need ≥ <since>). Update the CSI extension from the Chrome Web Store, or reload ~/.csi/extension.`

- [ ] **Step 2: 改 §2.2 `/status`**

示例 JSON 增加 `"extension_tools": ["navigate", "..."]`。说明：扩展握手上报了 `tools` 则为数组，未上报则为 `null`。

- [ ] **Step 3: 改 §4 标题为「工具清单（20 个）」**

改 snapshot 行：

`| 3 | snapshot | mode(compact/interactive/full，默认 compact), selector, max_chars(默认 24000，1000–80000) | {url, title, mode, chars, truncated, tree} | compact/interactive 的 tree 是 YAML 字符串；full 的 tree 是既有 JSON 数组。iframe 只输出一行不下行。|`

改 screenshot 行，args 加 `fullPage`。互斥：`fullPage` 与 `selector` 不能同时出现。

在 `mouse_click` 后插入（编号顺延，close_session 变成 20）：

```
| 9 | wait | 恰好 text/selector/url 之一；gone；timeout_ms(默认 15000，100–120000)；interval_ms(默认 200，50–2000) | {success, waitedMs, matched} | 扩展内轮询。@e 不在 ref 表则立刻失败。超时文案带 last url。 |
| 10 | scroll | 恰好 selector / to(top\|bottom) / direction(up\|down\|left\|right) 之一；amount(number\|"page"，仅 direction，默认 page) | {success, x, y, maxX, maxY} | page = 0.9 * innerHeight/innerWidth |
| 11 | hover | selector* | {success, x, y, tag, text} | Input.dispatchMouseEvent mouseMoved，不过 mousePressed |
```

原 9–17 编号改为 12–20（key_type 起）。

- [ ] **Step 4: 改 §6**

保留「不做自动降级」。补：

- 0.4.0 起 snapshot 默认 `mode=compact`，`tree` 为 YAML 字符串；旧客户端传 `mode=full`。
- 扩展未实现的工具由 daemon 按 §3.3 改写错误，不发 `tool_call`。
- `wait` / `scroll` / `hover` 自 0.4.0 引入。

- [ ] **Step 5: 提交**

```bash
git add docs/protocol.md docs/superpowers/specs/2026-03-30-agent-reliability-design.md
GIT_AUTHOR_DATE="2026-03-30T14:00:00+08:00" GIT_COMMITTER_DATE="2026-03-30T14:00:00+08:00" \
  git commit -m "协议 0.4：snapshot 改 YAML，加 wait/scroll/hover，hello 带 tools"
```

---

### Task 2: snapshot compact YAML（扩展）

**Files:**
- Create: `extension/src/background/tools/ax-yaml.ts`
- Modify: `extension/src/background/tools/snapshot.ts`
- Modify: `extension/src/background/tools/element.ts`（无需改接口；`resolveObjectId` 已导出）

**Interfaces:**
- Consumes: `assignRef` / `resetRefs` / `INTERACTIVE_ROLES`（`refs.ts`）；`resolveObjectId`（`element.ts`）；`sendCommand`。
- Produces:
  - `export type CompactNode`（见下）
  - `export function compactFromAx(nodes: AxNode[], mode: 'compact' | 'interactive'): CompactNode[]`
  - `export function renderYaml(nodes: CompactNode[], maxChars: number): { yaml: string; chars: number; truncated: boolean }`
  - snapshot 返回 `{ url, title, mode, chars, truncated, tree }`

AX 节点（本文件自己声明，不要从 snapshot.ts 循环引用）：

```ts
export type AxValue = { value?: unknown };
export type AxProp = { name: string; value?: AxValue };
export type AxNode = {
  nodeId: string;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: AxProp[];
};
```

- [ ] **Step 1: 写 `ax-yaml.ts`**

结构白名单（规格原文）：

```ts
export const STRUCTURAL_ROLES = new Set([
  'heading', 'paragraph', 'list', 'listitem', 'navigation', 'main',
  'banner', 'contentinfo', 'complementary', 'form', 'article', 'region',
  'img', 'table', 'row', 'rowheader', 'columnheader', 'cell', 'caption',
  'blockquote', 'separator', 'status', 'alert', 'dialog', 'iframe', 'text',
]);
```

`StaticText` 角色输出为 `text`。

属性读取：`properties` 里找 `level`（number）、`checked`（bool，有该属性才带 checked/unchecked）、`disabled` / `expanded` / `selected` / `invalid`（为真才输出）、`url`（iframe/img 的 `src`，截到 80 字符）。

收录：

1. `INTERACTIVE_ROLES` 且有 `backendDOMNodeId` → 调 `assignRef`，`ref` 写成 `@eN`。
2. 或角色在 `STRUCTURAL_ROLES`（`StaticText` 先映射成 `text`）。
3. 否则丢掉自己、子节点提升（与今天 generic/none 折叠相同）。
4. `iframe` **不下行**（`children` 强制空）。
5. `text` 若文本完整包含在最近祖先 `name` 里，丢掉。
6. 输出后既无 name/value/ref 也无子节点 → 删。
7. `interactive`：只保留带 `ref` 的节点，扁平（丢掉 children）。

YAML 行（属性固定顺序）：

```
<indent>- <role> ["<name>"] [level=N] [checked|unchecked] [selected] [expanded] [disabled] [invalid] [src=URL] [ref=@eN][: <value>]
```

`name` / `value` 一律 `JSON.stringify`。单个 name/value/text 超过 120 字符：截到 119 + `…`。

`renderYaml`：拼完整字符串后，若 `length > maxChars`，切到 `maxChars` 之前最后一个换行（没有换行就硬切），追加：

`\n... truncated, <n> chars omitted. Re-snapshot with selector or mode=interactive.`

`chars` 为**截断后**字符串长度。`truncated` 为是否切过。

文件头注释钉两组输入→输出，实现后对照：

```
heading "Sign in" level=1 + textbox Email ref + iframe recaptcha
→
- heading "Sign in" [level=1]
- textbox "Email" [ref=@e1]
- iframe "reCAPTCHA" [src=https://www.google.com/recaptcha/…]
```

（iframe 无子按钮。）第二组：祖先 name 已是 “Submit”、子 text 也是 “Submit” → 不单独输出 text。

- [ ] **Step 2: 改 `snapshot.ts`**

`execute(args)`：

1. `mode` 缺省 `"compact"`。非法值 → `snapshot: mode must be compact, interactive, or full`。
2. `max_chars` 缺省 24000；有值则必须是 1000–80000 的整数，否则报错。`full` 忽略此上限。
3. `resetRefs()` + `Accessibility.getFullAXTree`（现在就会返回 `properties`，类型补上）。
4. 若有 `selector`：`resolveObjectId('snapshot', selector)` → `DOM.describeNode({ objectId })` 取 `node.backendNodeId` → 在 AX 列表里找 `backendDOMNodeId` 相等的节点当根。找不到 → `snapshot: element not found: <selector>`。从该节点（含自身）往下格式化。
5. `full`：沿用现有 `buildTree`（根仍是整棵或子树根的 children+自身）。返回 `{ url, title, mode:'full', chars: JSON.stringify(tree).length, truncated:false, tree }`。`tree` 是数组。
6. `compact` / `interactive`：`compactFromAx` + `renderYaml`。返回 `tree` 为字符串。

`full` 路径继续折叠 generic/none，**不要**把 YAML 属性塞进 JSON。

- [ ] **Step 3: typecheck + build**

```bash
cd extension && npm run typecheck && npm run build
```

Expected: 退出码 0。

- [ ] **Step 4: 提交**

```bash
git add extension/src/background/tools/ax-yaml.ts extension/src/background/tools/snapshot.ts
GIT_AUTHOR_DATE="2026-03-30T16:30:00+08:00" GIT_COMMITTER_DATE="2026-03-30T16:30:00+08:00" \
  git commit -m "snapshot 默认改 compact YAML，大页面不再把整棵 JSON 塞进模型"
```

---

### Task 3: hello.tools 握手 + /status.extension_tools

**Files:**
- Modify: `daemon/internal/ws/hub.go`
- Modify: `daemon/internal/ws/hub_test.go`
- Modify: `daemon/internal/server/server.go`
- Modify: `daemon/internal/server/server_test.go`
- Modify: `daemon/internal/tools/tools.go`（只加 `Names()`，先不改 validTools）
- Modify: `extension/src/shared/messages.ts`
- Modify: `extension/src/background/registry.ts`
- Modify: `extension/src/background/ws-client.ts`
- Modify: `extension/src/background/index.ts`

**Interfaces:**
- Produces:
  - `func Names() []string` — `validTools` 的键，字典序。
  - `func (h *Hub) ExtensionTools() []string` — 未上报返回 `nil`；上报了返回拷贝（可为空切片）。
  - `func (h *Hub) SetDaemonTools(names []string)`
  - `HelloPayload.tools?: string[]`
  - `export function toolNames(): string[]`
  - `/status.extension_tools`：`string[] | null`

- [ ] **Step 1: 写失败测试（hub）**

在 `hub_test.go` 追加：

```go
func TestHandshakeStoresTools(t *testing.T) {
	h, url := newTestHub(t)
	h.SetDaemonTools([]string{"navigate", "wait"})
	conn := dial(t, url)
	hello, _ := json.Marshal(map[string]any{
		"extensionVersion": "0.4.0",
		"tools":            []string{"navigate", "snapshot"},
	})
	if err := conn.WriteJSON(Message{Type: MsgHello, Payload: hello}); err != nil {
		t.Fatal(err)
	}
	var ack Message
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	var p struct {
		DaemonVersion string   `json:"daemonVersion"`
		Tools         []string `json:"tools"`
	}
	_ = json.Unmarshal(ack.Payload, &p)
	if p.DaemonVersion != "test" {
		t.Fatalf("daemonVersion=%q", p.DaemonVersion)
	}
	if len(p.Tools) != 2 || p.Tools[0] != "navigate" || p.Tools[1] != "wait" {
		t.Fatalf("ack tools=%v", p.Tools)
	}
	waitFor(t, h.Connected, "connected")
	got := h.ExtensionTools()
	if len(got) != 2 || got[0] != "navigate" || got[1] != "snapshot" {
		t.Fatalf("ExtensionTools=%v", got)
	}
}

func TestHandshakeMissingToolsIsNil(t *testing.T) {
	h, url := newTestHub(t)
	_ = dialHello(t, url) // 现有 helper 不带 tools
	waitFor(t, h.Connected, "connected")
	if h.ExtensionTools() != nil {
		t.Fatalf("want nil, got %v", h.ExtensionTools())
	}
}
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd daemon && go test ./internal/ws -count=1 -run 'TestHandshakeStoresTools|TestHandshakeMissingToolsIsNil'
```

Expected: FAIL，`SetDaemonTools` / `ExtensionTools` undefined，或 ack 没有 `tools`。

- [ ] **Step 3: 实现 hub**

`Hub` 增加：

```go
daemonTools []string
extTools    []string
extAdvertised bool
```

`SetDaemonTools` 存一份拷贝。

`handshake` 改为返回 `(version string, tools *[]string, ok bool)`。payload：

```go
var p struct {
	ExtensionVersion string    `json:"extensionVersion"`
	Tools            *[]string `json:"tools"`
}
```

`setConn(conn, ver, tools *[]string)`：若 `tools != nil`，`extAdvertised=true` 并拷贝；否则 `extAdvertised=false`、`extTools=nil`。

`connDone` / `Close` 在清空 conn 时同时 `extAdvertised=false; extTools=nil`。

`ExtensionTools()`：未 advertised 返回 `nil`；否则返回拷贝。

`hello_ack`：

```go
ack, _ := json.Marshal(map[string]any{
	"daemonVersion": h.Version,
	"tools":         h.daemonTools,
})
```

`daemonTools` 为 nil 时 JSON 成 `[]` 或 `null` 均可；`server.New` 下一步会 Set。测试里先 Set。

- [ ] **Step 4: `tools.Names()` + `server.New` 灌进 Hub**

```go
func Names() []string {
	out := make([]string, 0, len(validTools))
	for n := range validTools {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}
```

`server.New` 在 `ws.New` 之后：`hub.SetDaemonTools(tools.Names())`。

- [ ] **Step 5: `/status`**

`statusResponse` 增加：

```go
ExtensionTools *[]string `json:"extension_tools"`
```

```go
var extTools *[]string
if t := s.Hub.ExtensionTools(); t != nil {
	cp := append([]string(nil), t...)
	extTools = &cp
}
```

未上报 → JSON `null`。

在 `TestHelloAckAndStatus` 里：不带 tools 的 hello 之后断言 `st["extension_tools"] == nil`。另写一个带 tools 的用例断言数组。`daemonVersion` 仍是 `0.3.0`（本任务不改版本）。

- [ ] **Step 6: 扩展 hello 带 tools**

`HelloPayload` 加 `tools?: string[]`。

`registry.ts`：

```ts
export function toolNames(): string[] {
  return [...registry.keys()];
}
```

`WsClientOptions` 加 `tools: string[]`。hello：

```ts
const payload: HelloPayload = {
  extensionVersion: chrome.runtime.getManifest().version,
  tools: this.tools,
};
```

`index.ts`：`registerAllTools()` 之后 `new WsClient({ onToolCall, tools: toolNames() })`。

- [ ] **Step 7: 跑测试**

```bash
cd daemon && go test ./... && go vet ./...
cd extension && npm run typecheck && npm run build
```

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add daemon/internal/ws daemon/internal/server daemon/internal/tools/tools.go \
  extension/src/shared/messages.ts extension/src/background/registry.ts \
  extension/src/background/ws-client.ts extension/src/background/index.ts
GIT_AUTHOR_DATE="2026-03-31T10:00:00+08:00" GIT_COMMITTER_DATE="2026-03-31T10:00:00+08:00" \
  git commit -m "hello 带 tools 清单，/status 能看出扩展会什么"
```

---

### Task 4: validTools + 缺工具改写

**Files:**
- Modify: `daemon/internal/tools/tools.go`
- Create: `daemon/internal/tools/tools_test.go`
- Modify: `daemon/internal/server/server.go`（`Executor.Inventory = hub`）

**Interfaces:**
- Consumes: `Hub.ExtensionVersion()`、`Hub.ExtensionTools()`（Task 3）。
- Produces:
  - `var toolSince = map[string]string{"wait":"0.4.0","scroll":"0.4.0","hover":"0.4.0"}`
  - `type Inventory interface { ExtensionVersion() string; ExtensionTools() []string }`
  - `Executor.Inventory Inventory`（可 nil，测试可注入）
  - `validTools` 增加 `wait` `scroll` `hover`

错误格式（精确，含句点和引号）：

```
extension 0.3.0 does not implement "wait" (need ≥ 0.4.0). Update the CSI extension from the Chrome Web Store, or reload ~/.csi/extension.
```

`%q` 打工具名。版本空则写 `unknown`。

- [ ] **Step 1: 写失败测试**

`tools_test.go`：

```go
package tools

import (
	"context"
	"strings"
	"testing"

	"csi/daemon/internal/session"
)

type fakeBE struct{ called string }

func (f *fakeBE) Name() string          { return "fake" }
func (f *fakeBE) Connected() bool       { return true }
func (f *fakeBE) CallTool(_ context.Context, name string, _ map[string]any) (any, error) {
	f.called = name
	return map[string]any{"ok": true}, nil
}

type fakeInv struct {
	ver   string
	tools []string // nil = 未上报
}

func (f fakeInv) ExtensionVersion() string { return f.ver }
func (f fakeInv) ExtensionTools() []string { return f.tools }

func TestMissingToolNotForwarded(t *testing.T) {
	be := &fakeBE{}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{ver: "0.3.0", tools: nil}
	_, err := ex.Execute(context.Background(), "wait", "s", nil)
	if err == nil || !strings.Contains(err.Error(), `does not implement "wait"`) {
		t.Fatalf("err=%v", err)
	}
	if !strings.Contains(err.Error(), "need ≥ 0.4.0") || !strings.Contains(err.Error(), "Chrome Web Store") {
		t.Fatalf("err=%v", err)
	}
	if be.called != "" {
		t.Fatalf("backend was called with %q", be.called)
	}
}

func TestAdvertisedToolsForwarded(t *testing.T) {
	be := &fakeBE{}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{ver: "0.4.0", tools: []string{"wait", "navigate"}}
	if _, err := ex.Execute(context.Background(), "wait", "s", nil); err != nil {
		t.Fatal(err)
	}
	if be.called != "wait" {
		t.Fatalf("called=%q", be.called)
	}
}

func TestAdvertisedMissingNotForwarded(t *testing.T) {
	be := &fakeBE{}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{ver: "0.4.0", tools: []string{"navigate"}}
	_, err := ex.Execute(context.Background(), "wait", "s", nil)
	if err == nil || !strings.Contains(err.Error(), `does not implement "wait"`) {
		t.Fatalf("err=%v", err)
	}
	if be.called != "" {
		t.Fatal("backend called")
	}
}

func TestUnknownToolUnchanged(t *testing.T) {
	ex := NewExecutor(&fakeBE{}, session.NewManager())
	_, err := ex.Execute(context.Background(), "not_a_tool", "s", nil)
	if err == nil || err.Error() != "unknown tool: not_a_tool" {
		t.Fatalf("err=%v", err)
	}
}
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd daemon && go test ./internal/tools -count=1 -run 'TestMissingTool|TestAdvertised|TestUnknownTool'
```

Expected: FAIL（`wait` 仍是 unknown tool，或 Inventory 不存在）。

- [ ] **Step 3: 实现**

`validTools` 加三个键。注释改「协议 §4 的 20 个工具名」。

```go
var toolSince = map[string]string{
	"wait":   "0.4.0",
	"scroll": "0.4.0",
	"hover":  "0.4.0",
}

type Inventory interface {
	ExtensionVersion() string
	ExtensionTools() []string
}

type Executor struct {
	Backend   backend.Backend
	Sessions  *session.Manager
	Inventory Inventory
}
```

`Execute` 在 `Valid` 通过之后、`Inject` 之前：

```go
if err := e.checkExtension(action); err != nil {
	return nil, err
}
```

```go
func (e *Executor) checkExtension(action string) error {
	if e.Inventory == nil {
		return nil
	}
	ver := e.Inventory.ExtensionVersion()
	if ver == "" {
		ver = "unknown"
	}
	listed := e.Inventory.ExtensionTools()
	if listed != nil {
		for _, n := range listed {
			if n == action {
				return nil
			}
		}
		return missingTool(ver, action)
	}
	if _, added := toolSince[action]; added {
		return missingTool(ver, action)
	}
	return nil
}

func missingTool(ver, action string) error {
	need, ok := toolSince[action]
	if !ok {
		need = "a newer CSI extension"
	}
	return fmt.Errorf("extension %s does not implement %q (need ≥ %s). Update the CSI extension from the Chrome Web Store, or reload ~/.csi/extension.", ver, action, need)
}
```

`server.New`：`ex := tools.NewExecutor(be, sessions); ex.Inventory = hub`。Hub 已有这两个方法。

- [ ] **Step 4: 跑测试**

```bash
cd daemon && go test ./... && go vet ./...
```

Expected: PASS。此时 MCP 仍是 17 个工具——下一任务再齐。`unknown tool: wait` 不应再出现在「未上报 tools 的 0.3.0 扩展」路径上。

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/tools daemon/internal/server/server.go
GIT_AUTHOR_DATE="2026-03-31T14:00:00+08:00" GIT_COMMITTER_DATE="2026-03-31T14:00:00+08:00" \
  git commit -m "扩展缺 wait 时说请升级，别再丢一句 unknown tool"
```

---

### Task 5: wait 工具（扩展）

**Files:**
- Create: `extension/src/background/tools/wait.ts`
- Modify: `extension/src/background/registry.ts`

**Interfaces:**
- Consumes: `getCurrentTab`、`ensureAttached`、`sendCommand`、`resolveObjectId`、`lookupRef` / `isRefSelector`、`DOM.getBoxModel`。
- Produces: `WaitTool.name === "wait"`。成功 `{ success:true, waitedMs:number, matched:string }`。

- [ ] **Step 1: 写 `wait.ts`**

校验：

- `text` / `selector` / `url` 里恰好一个是非空字符串，否则 `wait: specify exactly one of text, selector, url`。
- `gone` 缺省 false。
- `timeout_ms` 缺省 15000，范围 100–120000。
- `interval_ms` 缺省 200，范围 50–2000。
- `selector` 且 `isRefSelector` 且 `!lookupRef(selector)` → **立刻**
  `wait: unknown ref "<sel>". Run snapshot first, or wait on a CSS selector / text instead.`
  不要进循环。

循环：`const start = Date.now(); const deadline = start + timeout`。每次 `check()`，true 则返回。`await new Promise(r => setTimeout(r, interval))`。超时：

`wait: timed out after <timeout>ms waiting for <kind> "<value>" (last url: <tab.url>)`

`gone=true` 时 kind 前缀 `gone:`（成功 `matched` 也是，例如 `gone:selector:.spinner`）。成功 `matched`：`text:<原串>` / `selector:<原串>` / `url:<原串>`。`waitedMs = Date.now() - start`。

`check`：

- `url`：`chrome.tabs.get(currentId)` 的 `url`（可能 undefined 当 `""`）`includes` 子串。
- `text`：先 `Runtime.evaluate` `document.body && document.body.innerText.includes(<JSON.stringify(needle)>)`。false 再 `Accessibility.getFullAXTree`，任一 node 的 `name.value` 字符串包含 needle。
- `selector`：CSS → `document.querySelector` 拿到 objectId（`returnByValue:false`）；`@e` → `resolveObjectId`。然后 `DOM.getBoxModel`，border/content 至少 8 个数且宽高 > 0。再 `Runtime.callFunctionOn` 读 `this.getAttribute('aria-hidden') === 'true'`，true 则当不满足。元素不存在 / 无盒 → 不满足（不要抛，让循环继续），除非是 unknown ref（已在循环外抛过）。

`gone`：对 `check` 取反。

不要用 `chrome.alarms`。attach 当前 tab 一次，循环内不要反复 attach。

- [ ] **Step 2: registry 注册**

`register(new WaitTool());` 放在 `SendKeysTool` 附近。`wait` **不要**进 `SESSION_SCOPED_TOOLS`（它作用在当前 tab）。

- [ ] **Step 3: typecheck + build**

```bash
cd extension && npm run typecheck && npm run build
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add extension/src/background/tools/wait.ts extension/src/background/registry.ts
GIT_AUTHOR_DATE="2026-03-31T17:30:00+08:00" GIT_COMMITTER_DATE="2026-03-31T17:30:00+08:00" \
  git commit -m "加 wait：扩展里轮询文字/选择器/URL，别再让模型写 bash while"
```

---

### Task 6: screenshot.fullPage

**Files:**
- Modify: `extension/src/background/tools/screenshot.ts`

**Interfaces:**
- Consumes: 现有 `Page.captureScreenshot`。
- Produces: args.`fullPage?: boolean`。与 `selector` 互斥。

- [ ] **Step 1: 改 execute**

在读 `selector` 之后：

```ts
const fullPage = args.fullPage === true;
if (fullPage && selector) {
  throw new Error('screenshot: fullPage and selector are mutually exclusive');
}
```

无 selector 时：

```ts
const params: CaptureParams & { captureBeyondViewport?: boolean } = { format };
if (quality !== undefined) params.quality = quality;
if (fullPage) params.captureBeyondViewport = true;
```

`selector` 分支保持 clip，不要加 `captureBeyondViewport`。

CDP 抛错且 `fullPage`：包成

`screenshot: fullPage failed (<原消息>); try selector or a smaller viewport`

- [ ] **Step 2: typecheck + build**

```bash
cd extension && npm run typecheck && npm run build
```

- [ ] **Step 3: 提交**

```bash
git add extension/src/background/tools/screenshot.ts
GIT_AUTHOR_DATE="2026-04-01T10:00:00+08:00" GIT_COMMITTER_DATE="2026-04-01T10:00:00+08:00" \
  git commit -m "screenshot 支持 fullPage，长页不用再自己拼视口"
```

---

### Task 7: scroll + hover

**Files:**
- Create: `extension/src/background/tools/scroll.ts`
- Create: `extension/src/background/tools/hover.ts`
- Modify: `extension/src/background/registry.ts`

**Interfaces:**
- `ScrollTool` 返回 `{ success:true, x, y, maxX, maxY }`（数字，四舍五入到整数）。
- `HoverTool` 返回与 `mouse_click` 相同：`{ success, x, y, tag, text }`。

- [ ] **Step 1: 写 `scroll.ts`**

恰好一个目标：

```ts
const hasSel = typeof args.selector === 'string' && args.selector.length > 0;
const to = args.to as string | undefined;
const dir = args.direction as string | undefined;
const n = Number(hasSel) + Number(!!to) + Number(!!dir);
if (n !== 1) throw new Error('scroll: specify exactly one of selector, to, direction');
```

`to` 只接受 `top` / `bottom`。`direction` 只接受 `up` / `down` / `left` / `right`。

`selector`：`resolveObjectId` + 已有 `scrollIntoView`。

`to` / `direction`：一次 `Runtime.evaluate`，`awaitPromise` 不必。表达式用 IIFE：

- `top`：`window.scrollTo(0, 0)`
- `bottom`：`window.scrollTo(0, document.documentElement.scrollHeight)`
- `direction`：`amount` 缺省 `"page"`。`"page"` → 纵向 `0.9 * innerHeight`，横向 `0.9 * innerWidth`。数字 → 该像素。其它字符串 → `scroll: amount must be a number or "page"`。
  - up: `scrollBy(0, -delta)` 等。

然后同一 evaluate（或随后一次）读：

```js
({
  x: window.scrollX,
  y: window.scrollY,
  maxX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  maxY: Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight),
})
```

`selector` 路径也要返回滚动位置（scrollIntoView 之后读 window）。

- [ ] **Step 2: 写 `hover.ts`**

抄 `mouse-click.ts` 到取盒中心为止。只发一条：

```ts
await sendCommand('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x, y,
  button: 'none',
  buttons: 0,
});
```

**不要** `mousePressed` / `mouseReleased`。返回形状与 mouse_click 相同。缺 selector：`hover: selector is required (CSS selector or @e ref)`。无盒错误前缀 `hover:`。

- [ ] **Step 3: 注册**

`register(new ScrollTool()); register(new HoverTool());` 不要进 `SESSION_SCOPED_TOOLS`。

- [ ] **Step 4: typecheck + build**

```bash
cd extension && npm run typecheck && npm run build
```

- [ ] **Step 5: 提交**

```bash
git add extension/src/background/tools/scroll.ts extension/src/background/tools/hover.ts \
  extension/src/background/registry.ts
GIT_AUTHOR_DATE="2026-04-01T14:00:00+08:00" GIT_COMMITTER_DATE="2026-04-01T14:00:00+08:00" \
  git commit -m "加 scroll/hover，悬停菜单和翻页不用再 evaluate"
```

---

### Task 8: MCP schema 对齐 20 个工具

**Files:**
- Modify: `daemon/internal/mcp/tools.go`
- Modify: `daemon/internal/mcp/mcp_test.go`
- Modify: `daemon/internal/mcp/server.go`（注释 17→20）
- Modify: `daemon/cmd/csi/main.go`、`daemon/cmd/csi/commands.go`（注释 17→20）

**Interfaces:**
- Consumes: 协议 §4（Task 1）。
- Produces: `toolDefs` 长度 20；`wantTools` 同步。

- [ ] **Step 1: 改测试期望（先红）**

`wantTools` 在 `mouse_click` 后插入 `"wait", "scroll", "hover"`（或按 Names() 字典序断言长度 20 且包含这三个——长度+包含即可，顺序跟 `toolDefs` 切片走）。

```go
if len(res.Tools) != 20 {
	t.Fatalf("got %d tools, want 20", len(res.Tools))
}
```

`wantRequired` 增加：

```go
"hover": {"selector"},
```

`wait` / `scroll` 无协议级 required（运行时恰好一个），不要写进 `wantRequired`。

- [ ] **Step 2: 跑 MCP 测试，确认失败**

```bash
cd daemon && go test ./internal/mcp -count=1 -run TestToolRegistration
```

Expected: FAIL `got 17 tools, want 20`。

- [ ] **Step 3: 补 `toolDefs`**

`snapshot.props`：

```go
"mode":      strEnumProp("Snapshot verbosity. compact=YAML with structure+refs (default); interactive=refs only; full=JSON tree.", "compact", "interactive", "full"),
"selector":  strProp("Limit the snapshot to this element (@e ref or CSS)."),
"max_chars": intProp("Max YAML characters for compact/interactive (default 24000, range 1000-80000)."),
```

`screenshot.props` 加 `"fullPage": boolProp("Capture the full scrollable page. Mutually exclusive with selector.")`。

在 `mouse_click` 条目之后插入：

```go
{
	name:        "wait",
	description: "Wait until text appears, a selector is visible, or the tab URL contains a substring. Exactly one of text, selector, url.",
	props: map[string]any{
		"text":        strProp("Substring to find in visible text or AX names."),
		"selector":    strProp("@e ref or CSS selector to wait for (visible, non-zero box)."),
		"url":         strProp("Substring the current tab URL must contain."),
		"gone":        boolProp("Invert: wait until the condition is no longer true."),
		"timeout_ms":  intProp("Timeout in milliseconds (default 15000, max 120000). Must be less than the daemon tool timeout."),
		"interval_ms": intProp("Poll interval in milliseconds (default 200)."),
	},
},
{
	name:        "scroll",
	description: "Scroll the page or an element into view. Exactly one of selector, to, direction.",
	props: map[string]any{
		"selector":  strProp("Scroll this element into the center of the viewport."),
		"to":        strEnumProp("Scroll to the top or bottom of the page.", "top", "bottom"),
		"direction": strEnumProp("Scroll one step in this direction.", "up", "down", "left", "right"),
		"amount":    map[string]any{"description": "Pixels or \"page\" (default page). Only with direction."},
	},
},
{
	name:        "hover",
	description: "Move the mouse over an element (CSS :hover menus). Trusted mouseMoved, no click.",
	props: map[string]any{
		"selector": strProp("@e ref or CSS selector to hover."),
	},
	required: []string{"selector"},
},
```

`amount` 不要标成单一 type（number | "page"）。用 description 即可，避免假 schema。

- [ ] **Step 4: 跑测试**

```bash
cd daemon && go test ./... && go vet ./...
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/mcp daemon/cmd/csi/main.go daemon/cmd/csi/commands.go
GIT_AUTHOR_DATE="2026-04-01T17:00:00+08:00" GIT_COMMITTER_DATE="2026-04-01T17:00:00+08:00" \
  git commit -m "MCP 补 wait/scroll/hover，工具表收到 20"
```

---

### Task 9: 技能、文档、宣传页清单对齐

**Files:**
- Modify: `skills/csi/SKILL.md`
- Modify: `skills/csi/references/operations.md`
- Modify: `skills/csi-e2e/references/workflow.md`
- Modify: `.claude/rules/protocol-sync.md`（「17」→「20」）
- Modify: `README.md`、`README.zh-CN.md`
- Modify: `extension/CLAUDE.md`、`extension/src/background/index.ts` 文件头「17」
- Modify: `site/src/data/tools.ts`
- Modify: `site/src/i18n/zh.ts`、`site/src/i18n/en.ts`（工具件数 17→20；`@e17` 是 ref 编号，**不要改**）
- 若 `site/src/components/Features.tsx` 硬编码了「17 件工具」，一并改。用 grep `17` 扫 `site/src` 与根 README。

**Interfaces:**
- SKILL 表必须与 protocol §4 的 20 个名字一致。

- [ ] **Step 1: SKILL 工具表**

`snapshot` 行改为：

`| snapshot | mode(compact/interactive/full), selector, max_chars | {url,title,mode,chars,truncated,tree} | 默认 compact YAML，可交互带 @e。truncated 时换 interactive 或对容器传 selector。调试才用 full |`

`screenshot` 行加上 `fullPage`。加三行：

```
| wait | 恰好 text/selector/url 之一；gone；timeout_ms；interval_ms | {success,waitedMs,matched} | 一次调用，扩展内轮询。优先 text 或 CSS；@e 不在表里会立刻失败 |
| scroll | 恰好 selector / to / direction 之一；amount | {success,x,y,maxX,maxY} | page = 0.9 视口。maxY=0 表示不能再往下滚 |
| hover | selector* | {success,x,y,tag,text} | CSS :hover 菜单。不是 DOM mouseover |
```

「Prefer snapshot」节：默认不要传 mode；被截断先 `mode=interactive`，再对容器 `selector`。`full` 仅调试。

「Evaluate Tips」里「or scroll」改成：滚动用 `scroll`，等 UI 用 `wait`，evaluate 仍是最后手段。

在 Special keys 前加一节 **Wait**：

- 等到文字 / 元素 / URL，不要写 bash `while` + `evaluate`。
- `timeout_ms` 必须小于 daemon 工具超时（默认 120s）。
- 超时先读 error 里的 last url，再 snapshot，不要当成功。

Screenshots 节加一条 `fullPage:true` 示例，并写与 `selector` 互斥。

Known limitations：iframe 仍写「0.4 只在 snapshot 里露出一行 iframe，不下行；要操作请 navigate 进 iframe URL」。保留 isTrusted 那条，补一句菜单用 `hover`。

- [ ] **Step 2: operations.md**

在「Do NOT do automatically」的 version mismatch 段改为：

1. error 含 `does not implement` → 让用户升级扩展（商店或 reload `~/.csi/extension`）。不要 start/stop/restart。
2. `unknown tool` 且 `/status.version` < 0.4.0 → 让用户升级 daemon（GitHub Release / 安装器）。
3. 不要自己「对齐版本」。

- [ ] **Step 3: e2e workflow.md**

把 bash `while` + evaluate 轮询示例换成：

```bash
curl -s -X POST http://127.0.0.1:10088/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"wait","args":{"text":"保存成功","timeout_ms":15000},"session":"e2e-myproj"}'
```

注明：live verify 用 `wait`；suite 回放仍可用 `pollUntil`（不经模型）。

- [ ] **Step 4: README / protocol-sync / 站点**

- README 与中文：「17 tools」→「20 tools」，列表加上 `wait` `scroll` `hover`，snapshot 注明默认 YAML。
- MCP 段「all 17」→「all 20」。
- `.claude/rules/protocol-sync.md`：「当前 17 个」→「当前 20 个」。
- `site/src/data/tools.ts` 加三行中英描述（各一句话，跟现有风格）。
- i18n：`ctaTools` / `tools.title` / 场景里「含 17 工具」改 20。不要改 `@e17`。

- [ ] **Step 5: 提交**

```bash
git add skills .claude/rules/protocol-sync.md README.md README.zh-CN.md \
  extension/CLAUDE.md extension/src/background/index.ts site/src
GIT_AUTHOR_DATE="2026-04-02T10:00:00+08:00" GIT_COMMITTER_DATE="2026-04-02T10:00:00+08:00" \
  git commit -m "技能和文档跟上 20 个工具，wait 换成正路，轮询教程撤了"
```

---

### Task 10: 版本号 0.4.0 + 验收

**Files:**
- Modify: `daemon/internal/version/version.go` → `"0.4.0"`
- Modify: `daemon/internal/server/server_test.go` 里两处 `"0.3.0"` 断言（`daemonVersion` / `status.version`）→ `"0.4.0"`
- Modify: `extension/manifest.json`、`extension/package.json`、`package.json`、`site/package.json`
- Modify: `site/src/i18n/zh.ts` / `en.ts` 的 `footer.version` → `v0.4.0`
- Modify: 所有写了 `"version": "0.3.0"` 的插件清单（至少 `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`.codex-plugin/plugin.json`、`.cursor-plugin/plugin.json`、`.kimi-plugin/plugin.json`）。用 `git grep -n '0.3.0'` 扫一遍，漏了就补。
- Modify: `skills/csi/SKILL.md` 与 `skills/csi-e2e/SKILL.md` 的 `metadata.version`

`extension/package-lock.json` / `site/package-lock.json` 顶部 version 跟着 `npm` 走的话，改完 `package.json` 后在对应目录跑一次 `npm install --package-lock-only`（或手改 lock 里那两处 name/version，与 0.3.0 时相同做法）。

不要打 git tag（发版是另一件事，用户再说）。

- [ ] **Step 1: 改版本字符串**

全部改完后：

```bash
cd daemon && go test ./... && go vet ./...
cd ../extension && npm run typecheck && npm run build
```

Expected: PASS。`server_test` 若还钉 0.3.0 会红，一起改掉。

- [ ] **Step 2: 手测清单（实现者用本机 Chrome + 刚 build 的 dist）**

1. `go build -o ~/.csi/bin/csi ./cmd/csi && csi restart`。扩展 reload `extension/dist`。
2. `curl -s http://127.0.0.1:10088/status` → `version=0.4.0`，`extension_version=0.4.0`，`extension_tools` 含 `wait`。
3. example.com → `snapshot`（不传 mode）→ `tree` 是字符串，有 `[ref=@e`，`mode=compact`。
4. `snapshot` `mode=full` → `tree` 是数组。
5. `wait` `text=Example Domain` → `success`，`waitedMs` ≥ 0。
6. `wait` `text=___no_such___` `timeout_ms=800` → error 含 `timed out` 和 `last url`。
7. `screenshot` `fullPage=true` 与 `selector=@e1` 一起发 → 互斥错误。
8. （可选）临时在 hello 里去掉 `wait` 或连一只没更新的扩展：`wait` 应返回 `does not implement`，daemon 日志里没有对应 tool_call。

- [ ] **Step 3: 提交**

```bash
git add daemon/internal/version/version.go daemon/internal/server/server_test.go \
  extension/manifest.json extension/package.json extension/package-lock.json \
  package.json site/package.json site/package-lock.json site/src/i18n \
  .claude-plugin .codex-plugin .cursor-plugin .kimi-plugin skills
GIT_AUTHOR_DATE="2026-04-02T15:00:00+08:00" GIT_COMMITTER_DATE="2026-04-02T15:00:00+08:00" \
  git commit -m "版本 0.4.0：可靠性这一枪收齐"
```

---

## Spec coverage（自检）

| 规格条款 | 任务 |
|---|---|
| A.1 compact / interactive / full、max_chars、selector 子树、iframe 不下行、扩展内压 YAML | Task 2 |
| A.2 wait 恰好一个条件、@e 立刻失败、超时带 url、扩展内轮询 | Task 5 |
| A.3 fullPage 互斥 | Task 6 |
| A.4 scroll | Task 7 |
| A.5 hover 只 mouseMoved | Task 7 |
| A.6 hello.tools、未上报=17 件套、does not implement、/status.extension_tools | Task 3–4 |
| A.7 protocol §4 / §3.3 / §6 | Task 1 |
| A.8 daemon 单测 + 扩展 typecheck/build + 手测 | Task 3–4、8、10 |
| 技能 / e2e / operations / 20 清单 | Task 9 |
| 版本 0.4.0 | Task 10 |
| 0.5 autostart / 0.6 iframe·dialog·download | **不在本计划** |

## 不要做

- 不要在 Task 2 给扩展加测试框架。
- 不要把 `wait` 拆成三个 MCP 工具。
- 不要让 daemon 把 JSON 再压成 YAML。
- 不要改 loopback / 加鉴权。
- 不要在本计划里打 `v0.4.0` tag。
