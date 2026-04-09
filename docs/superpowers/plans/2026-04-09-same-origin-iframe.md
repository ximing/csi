# 0.6.0 同域 iframe 穿透 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地规格 0.6.0：同域 iframe 可进（`snapshot` 对 iframe `@e` 或 `frame=` 再拍一次），跨域 iframe 列得出、进不去、错误稳定。工具数 20 → 21（新增 `list_frames`），7 个旧工具加可选 `frame` 参数，daemon 对旧扩展挡 `frame`。

**Architecture:** 协议先改。扩展继续 `chrome.debugger.attach({tabId})` 的 tab 会话（**不** attach OOPIF target）；同域子帧用 `Accessibility.getFullAXTree({frameId})` 拍树、用 default-world `contextId` 执行 JS；isolated 判定 fail closed（`securityOrigin` / sandbox / `contentDocument` / origin 比对）。ref 表加 `frameId`，进框 snapshot 不 reset。daemon 侧加 `list_frames` 进 `toolSince`，并对「带非空 `frame` 且扩展 < 0.6.0」的调用返回 `does not implement "frame"` 不转发。

**Tech Stack:** 现有 Go daemon + TypeScript MV3 扩展。不加依赖、不加测试跑器（扩展靠 typecheck/build + 手测夹具，沿用 0.4/0.5 做法）。

**Spec:** `docs/superpowers/specs/2026-04-04-same-origin-iframe-design.md`（随 Task 1 改「已确认」）。**本计划只做 0.6.0 同域 iframe。** C.2 对话框、C.3 下载、跨域 OOPIF attach 另开计划，禁止顺手做。

## Global Constraints

- 协议先行：先改 `docs/protocol.md`，再改实现。五处清单同一发版结束时必须一致：protocol §4、`validTools`、MCP `toolDefs`、扩展 registry、`skills/csi/SKILL.md` 表（当前 20 个 → 21 个）。
- 错误文案精确（规格 §错误文案），逐字实现，不要改写：
  - `iframe: cross-origin frame "<url>" is not supported yet. If it is a full page, navigate to its URL.`（`<url>` 没有则 `unknown`）
  - `iframe: no frame matching "<value>"`
  - `iframe: multiple frames match "<value>": <url>, <url>, …`（最多列 5 个）
  - `iframe: selector and frame do not refer to the same frame`
  - `iframe: frame is gone; run snapshot again`
  - `extension <ver> does not implement "frame" (need ≥ 0.6.0). Update the CSI extension from the Chrome Web Store, or reload ~/.csi/extension.`
- 进不去的帧 **禁止** 返回成功空 YAML；业务错误仍走 HTTP 200 body 的 `error`。
- 坐标：`DOM.getBoxModel` / `getContentQuads` 已是根视口 CSS 像素，`mouse_click` / `hover` / clip **不要** 加 iframe 元素 offset，嵌套同域也不累加。
- **禁止** `Target.setAutoAttach` flatten、**禁止** 对 iframe `attach({targetId})`、**禁止** 把 `targetId` / session id 暴露给调用方；`getFullAXTree({frameId})` 被拒时报错，**不得**改 attach target 混过去。
- 不设 `descend_frames`，不展平所有帧；整页 snapshot 仍一行 iframe 不下行（token 与 0.4 同量级）。
- isolated 判定 fail closed：比不出来就算 isolated；不要把 srcdoc / about:blank 一律当同域。
- `_` 前缀字段只由 daemon 注入。本计划不新增 `_` 字段。
- 不改安全边界（只绑 `127.0.0.1`，无鉴权）。不做对话框、下载，不申请 `downloads` 权限。
- daemon 改完：`cd daemon && go test ./... && go vet ./...`。扩展改完：`cd extension && npm run typecheck && npm run build`。
- 版本号留到 Task 10 一次性改 0.6.0。中间 commit 保持 0.5.0。不打 tag。
- 扩展不加测试框架；扩展验证 = typecheck/build + Task 10 手测夹具。

## File map

| 文件 | 职责 |
|---|---|
| `docs/protocol.md` | 契约：§3.3 `frame` 闸、§4 加 `list_frames` 第 21 + snapshot/7 工具补 `frame` + §4.1 iframe 小节、§6 写 0.6.0 |
| `daemon/internal/tools/tools.go` | `validTools` + `list_frames`；`toolSince` + 两条 0.6.0；`frame` 参数闸（semver 比较） |
| `daemon/internal/tools/tools_test.go` | 闸的 8 个新用例 |
| `daemon/internal/mcp/tools.go` | `list_frames` def；8 个工具补 `frame` prop |
| `daemon/internal/mcp/mcp_test.go` | 21 个工具 |
| `extension/src/background/refs.ts` | `RefEntry.frameId?`；`assignRef` 第四参 |
| `extension/src/background/frames.ts` | 新建。帧发现 ∪、isolated 判定、`resolveFrame`、contextId 表、生命周期清空 |
| `extension/src/background/debugger-session.ts` | attach 后 `Page.enable`（供 frameNavigated） |
| `extension/src/background/tools/ax-yaml.ts` | iframe/frame 给 `@e`、`[isolated]`、`frameId` 透传 |
| `extension/src/background/tools/snapshot.ts` | `frame` 参数、进框入口判定、reset vs 追加、帧 url/title |
| `extension/src/background/tools/element.ts` | `resolveObjectId` 加 `frameId?`；`parseFrameArg` |
| `extension/src/background/tools/list-frames.ts` | 新建。`list_frames` 工具 |
| `extension/src/background/registry.ts` | 注册 `ListFramesTool`（不进 `SESSION_SCOPED_TOOLS`） |
| click/fill/evaluate/mouse_click/hover/screenshot/wait | 可选 `frame`；`@e` 忽略 `frame`；screenshot `fullPage+frame` clip 到 iframe 盒 |
| `extension/src/background/tools/navigate.ts` | navigate 清空 ref 表 |
| `skills/csi/SKILL.md`、operations.md、README×2、site、protocol-sync | 21 清单 + iframe 主路 + 升级提示 |

---

### Task 1: 协议 0.6.0 契约

**Files:**
- Modify: `docs/protocol.md`
- Modify: `docs/superpowers/specs/2026-04-04-same-origin-iframe-design.md`（状态「待确认」→「已确认」，随本任务一起提交）

**Interfaces:**
- Produces: 下文即实现必须遵守的形状。后续任务禁止另起字段名/错误文案。

- [ ] **Step 1: 改 §3.3**

在「扩展缺某个已调用工具时……」那条之后补一条：

- 调用方对任何工具传了非空 `frame`（string；`null` / 缺省 / 空字符串视为未传，**非字符串真值也算已传**）而扩展版本 < 0.6.0（或未上报 `tools`）时，daemon 同样**不转发**，返回
  `extension <ver> does not implement "frame" (need ≥ 0.6.0). Update the CSI extension from the Chrome Web Store, or reload ~/.csi/extension.`
  版本按 hello 的 `extensionVersion` 做 semver 主.次.补比较，解析失败视为不够。

- [ ] **Step 2: 改 §4**

标题「工具清单（20 个）」→「工具清单（21 个）」。

snapshot 行 args 改：
`mode`(compact/interactive/full，默认 compact), `selector`, `max_chars`(默认 24000，1000–80000), `frame`(frameId 或未截断 URL 子串)
备注改：compact/interactive 的 tree 是 YAML 字符串；full 的 tree 是既有 JSON 数组。iframe 只输出一行不下行，但带 `[ref=@eN]`，跨域行带 `[isolated]`；`frame` 或指向 iframe 的 `selector` 进入该帧再拍。

`evaluate` / `click` / `fill` / `mouse_click` / `hover` / `screenshot` / `wait` 七行 args 末尾各加 `, frame`；这些行备注补一句：「`@e` 自带 frameId，`frame` 只对 CSS/evaluate 生效」。

表尾加第 21 行（在 `close_session` 后）：

```
| 21 | `list_frames` | — | `{success, frames:[{frameId,parentId,url,name,isolated}]}` | 含顶层帧（`parentId` 为 `""`）。`isolated:true` 的帧本期进不去；无 CDP frameId 的 isolated 帧用 `isolated:<url>` 占位。不含 targetId |
```

- [ ] **Step 3: §4 表后新增「§4.1 iframe 与 frame 参数（0.6.0 起）」小节**

内容（照规格压缩，逐字保留错误文案）：

- 进框入口（snapshot 二选一）：`selector` 解析出的节点角色是 iframe/frame → 进其子帧；或 `frame` 非空 → 先按 frameId 精确匹配，再按未截断 frame URL 子串匹配。同时传且对不上 → `iframe: selector and frame do not refer to the same frame`。
- 匹配 0 个 → `iframe: no frame matching "<value>"`；≥2 个 → `iframe: multiple frames match "<value>": <url1>, <url2>, …`（最多 5 个）。
- 命中帧 isolated → `iframe: cross-origin frame "<url>" is not supported yet. If it is a full page, navigate to its URL.` 禁止返回成功空树。
- 同域帧已卸载 / context 失效 → `iframe: frame is gone; run snapshot again`。
- 进框 snapshot 返回 `{url, title, mode, chars, truncated, tree}`，`url`/`title` 用该帧的（title 没有就 `""`），`max_chars` 作用在该帧 YAML 上。只下一层。
- ref 表：`RefEntry` 加可选 `frameId`（空 = 顶层）。整页 snapshot 与非 iframe 的 selector 子树 → reset（`@e1` 起）；进帧 snapshot → 不 reset，序号续编，父页旧 `@e` 保留。navigate / 关 tab / 主文档 commit 导航 → 清空 ref 表。
- `frame` 在七个工具上：`@e` 忽略 `frame`（以 ref 表 frameId 为准）；CSS / evaluate 的 `code` 无 `frame` 在顶层、有 `frame` 在该帧（跨域走跨域错误）。
- `screenshot`：`fullPage` 与 `selector` 仍互斥；`fullPage + frame` clip 到该 iframe 元素在父页视口里的可见盒（不是子文档完整滚动高度）。
- `wait`：`url` 仍看 tab URL；`text`/`selector` 在指定帧（或 `@e` 所在帧）轮询。

- [ ] **Step 4: 改 §6**

补：

- `list_frames` 与工具参数 `frame` 自 0.6.0 引入；旧扩展由 daemon 按 §3.3 改写（`frame` 按参数闸）。
- 对 iframe 的 `@e` 再 snapshot 无法被 daemon 识别：0.5 扩展会拍到空壳，客户端应按 `/status.version` 与 `extension_tools` 规避。
- 0.6.0 起同域 iframe 可进入；`isolated:true`（跨域 OOPIF、不透明源、sandbox 无 allow-same-origin 等）只列不进。

- [ ] **Step 5: 提交**

```bash
git add docs/protocol.md docs/superpowers/specs/2026-04-04-same-origin-iframe-design.md
git commit -m "协议 0.6：list_frames + frame 参数，iframe 行给 @e，跨域标 isolated"
```

---

### Task 2: daemon — list_frames + frame 参数闸

**Files:**
- Modify: `daemon/internal/tools/tools.go`
- Modify: `daemon/internal/tools/tools_test.go`

**Interfaces:**
- Consumes: `Inventory`（已有：`ExtensionVersion()` / `ExtensionTools()` / `Connected()`）。
- Produces:
  - `validTools` 增加 `"list_frames"`（注释改「协议 §4 的 21 个工具名」）
  - `toolSince` 增加 `"list_frames": "0.6.0"` 与 `"frame": "0.6.0"`
  - `func (e *Executor) checkExtension(action string, args map[string]any) error`（签名加 args）
  - `func framePresent(v any) bool`、`func semverLess(ver string, major, minor, patch int) bool`

- [ ] **Step 1: 写失败测试**

在 `tools_test.go` 追加（`fakeBE` / `fakeInv` 复用现有）：

```go
func TestListFramesOldExtNotForwarded(t *testing.T) {
	be := &fakeBE{}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{ver: "0.5.0", tools: []string{"navigate", "snapshot"}}
	_, err := ex.Execute(context.Background(), "list_frames", "s", nil)
	if err == nil || !strings.Contains(err.Error(), `does not implement "list_frames"`) {
		t.Fatalf("err=%v", err)
	}
	if !strings.Contains(err.Error(), "need ≥ 0.6.0") {
		t.Fatalf("err=%v", err)
	}
	if be.called != "" {
		t.Fatalf("backend was called with %q", be.called)
	}
}

func TestListFramesUnadvertisedNotForwarded(t *testing.T) {
	be := &fakeBE{}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{ver: "0.3.0", tools: nil}
	_, err := ex.Execute(context.Background(), "list_frames", "s", nil)
	if err == nil || !strings.Contains(err.Error(), `does not implement "list_frames"`) {
		t.Fatalf("err=%v", err)
	}
	if be.called != "" {
		t.Fatal("backend called")
	}
}

func TestFrameGateOldExtNotForwarded(t *testing.T) {
	be := &fakeBE{}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{ver: "0.5.0", tools: []string{"snapshot"}}
	_, err := ex.Execute(context.Background(), "snapshot", "s", map[string]any{"frame": "pay"})
	if err == nil || !strings.Contains(err.Error(), `does not implement "frame"`) {
		t.Fatalf("err=%v", err)
	}
	if !strings.Contains(err.Error(), "need ≥ 0.6.0") || !strings.Contains(err.Error(), "Chrome Web Store") {
		t.Fatalf("err=%v", err)
	}
	if be.called != "" {
		t.Fatal("backend called")
	}
}

func TestFrameGateTruthyNonStringBlocked(t *testing.T) {
	be := &fakeBE{}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{ver: "0.5.0", tools: []string{"snapshot"}}
	_, err := ex.Execute(context.Background(), "snapshot", "s", map[string]any{"frame": true})
	if err == nil || !strings.Contains(err.Error(), `does not implement "frame"`) {
		t.Fatalf("err=%v", err)
	}
	if be.called != "" {
		t.Fatal("backend called")
	}
}

func TestFrameGateEmptyAndNullForwarded(t *testing.T) {
	for _, v := range []any{"", nil} {
		be := &fakeBE{}
		ex := NewExecutor(be, session.NewManager())
		ex.Inventory = fakeInv{ver: "0.5.0", tools: []string{"snapshot"}}
		if _, err := ex.Execute(context.Background(), "snapshot", "s", map[string]any{"frame": v}); err != nil {
			t.Fatalf("frame=%v: %v", v, err)
		}
		if be.called != "snapshot" {
			t.Fatalf("frame=%v: called=%q", v, be.called)
		}
	}
}

func TestFrameGateNewExtForwarded(t *testing.T) {
	be := &fakeBE{}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{ver: "0.6.0", tools: []string{"snapshot", "list_frames"}}
	if _, err := ex.Execute(context.Background(), "snapshot", "s", map[string]any{"frame": "pay"}); err != nil {
		t.Fatal(err)
	}
	if be.called != "snapshot" {
		t.Fatalf("called=%q", be.called)
	}
}

func TestFrameGateUnparsableVersionBlocked(t *testing.T) {
	be := &fakeBE{}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{ver: "dev-build", tools: []string{"snapshot"}}
	_, err := ex.Execute(context.Background(), "snapshot", "s", map[string]any{"frame": "pay"})
	if err == nil || !strings.Contains(err.Error(), `does not implement "frame"`) {
		t.Fatalf("err=%v", err)
	}
}

func TestFrameGateUnadvertisedBlocked(t *testing.T) {
	be := &fakeBE{}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{ver: "0.3.0", tools: nil}
	_, err := ex.Execute(context.Background(), "snapshot", "s", map[string]any{"frame": "pay"})
	if err == nil || !strings.Contains(err.Error(), `does not implement "frame"`) {
		t.Fatalf("err=%v", err)
	}
}
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd daemon && go test ./internal/tools -count=1 -run 'TestListFrames|TestFrameGate'
```

Expected: FAIL（`list_frames` 还是 unknown tool / 闸不存在）。

- [ ] **Step 3: 实现**

`tools.go`：

1. `validTools` 加 `"list_frames": true`，注释改 21。
2. `toolSince`：

```go
// toolSince 记录各工具/参数引入版本：旧扩展未上报 tools 时按此表视为缺失；
// "frame" 不是工具，是 0.6.0 起七个旧工具上的新参数闸（协议 §3.3、§4.1）。
var toolSince = map[string]string{
	"wait":        "0.4.0",
	"scroll":      "0.4.0",
	"hover":       "0.4.0",
	"list_frames": "0.6.0",
	"frame":       "0.6.0",
}
```

3. `Execute` 调整顺序：args 归一化挪到 `checkExtension` 之前，并传 args：

```go
	if !Valid(action) {
		return nil, fmt.Errorf("unknown tool: %s", action)
	}
	if sess == "" {
		sess = "default" // 协议 §2.1：缺省 session 为 "default"
	}
	if args == nil {
		args = map[string]any{}
	}
	if err := e.checkExtension(action, args); err != nil {
		return nil, err
	}
```

4. `checkExtension` 改签名并挂闸：

```go
// checkExtension 对照扩展清单；未实现则不转发，返回升级提示（协议 §3.3）。
// 未连接时不改写，交给后端返回 extension not connected。
// frame 闸（协议 §3.3）：0.5 及更早扩展会忽略未知字段，带非空 frame 转发
// 等于误操作顶层，所以一律拦下。
func (e *Executor) checkExtension(action string, args map[string]any) error {
	if e.Inventory == nil || !e.Inventory.Connected() {
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
				return checkFrameGate(ver, true, args)
			}
		}
		return missingTool(ver, action)
	}
	if _, added := toolSince[action]; added {
		return missingTool(ver, action)
	}
	return checkFrameGate(ver, false, args)
}

// checkFrameGate：args 带非空 frame 且扩展不够新（未上报 tools 视为不够）→ 不转发。
func checkFrameGate(ver string, advertised bool, args map[string]any) error {
	v, ok := args["frame"]
	if !ok || !framePresent(v) {
		return nil
	}
	if !advertised || semverLess(ver, 0, 6, 0) {
		return missingTool(ver, "frame")
	}
	return nil
}

// framePresent：null 与空字符串视为未传；非字符串真值（如 true）算已传。
func framePresent(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case bool:
		return t
	case float64:
		return t != 0
	default:
		return true
	}
}

// semverLess 主.次.补比较；解析失败视为不够新（协议 §3.3）。
func semverLess(ver string, major, minor, patch int) bool {
	parts := strings.Split(ver, ".")
	if len(parts) != 3 {
		return true
	}
	want := [3]int{major, minor, patch}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return true
		}
		if n != want[i] {
			return n < want[i]
		}
	}
	return false
}
```

5. import 加 `"strconv"`、`"strings"`。

注意：`missingTool(ver, "frame")` 复用现有句式，`toolSince["frame"]` 已给 `"0.6.0"`，文案自动正确。`validTools` 不含 `"frame"`，`Valid("frame")` 永远 false，`toolSince["frame"]` 不会被当成工具查。

- [ ] **Step 4: 跑测试**

```bash
cd daemon && go test ./... && go vet ./...
```

Expected: PASS（含 0.4/0.5 旧用例）。

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/tools/tools.go daemon/internal/tools/tools_test.go
git commit -m "daemon 认 list_frames，带 frame 的旧扩展调用拦下说请升级"
```

---

### Task 3: daemon — MCP 21 个工具 schema

**Files:**
- Modify: `daemon/internal/mcp/tools.go`
- Modify: `daemon/internal/mcp/mcp_test.go`
- Modify: `daemon/internal/mcp/server.go`（注释 20→21，两处）
- Modify: `daemon/cmd/csi/main.go`、`daemon/cmd/csi/commands.go`（注释 20→21）

**Interfaces:**
- Consumes: 协议 §4（Task 1）。
- Produces: `toolDefs` 长度 21；snapshot/evaluate/click/fill/mouse_click/hover/screenshot/wait 带 `frame` prop。

- [ ] **Step 1: 改测试期望（先红）**

`mcp_test.go`：`wantTools` 在 `"close_session"` 后加 `"list_frames"`；`TestToolRegistration` 的计数 20 → 21（两处：错误信息里 `want 21`）。`wantRequired` 不加 `list_frames`（无参数）。

- [ ] **Step 2: 跑 MCP 测试，确认失败**

```bash
cd daemon && go test ./internal/mcp -count=1 -run TestToolRegistration
```

Expected: FAIL `got 20 tools, want 21`。

- [ ] **Step 3: 补 `toolDefs`**

表尾（`close_session` 之后）加：

```go
	{
		name:        "list_frames",
		description: "List all frames in the current tab, including cross-origin iframes (marked isolated, cannot be entered).",
		props:       map[string]any{},
	},
```

`snapshot.props` 加：

```go
		"frame": strProp("Enter a same-origin iframe and snapshot only it: CDP frameId or an untruncated substring of the frame URL. Alternative to passing a selector that points at an iframe @e ref."),
```

`click` / `fill` / `mouse_click` / `hover` 的 `props` 各加：

```go
		"frame": strProp("Frame to resolve CSS selectors in (frameId or URL substring). Ignored for @e refs — they carry their own frame."),
```

`evaluate.props` 加：

```go
		"frame": strProp("Frame to run the code in (frameId or URL substring). Default: top frame."),
```

`screenshot.props` 加：

```go
		"frame": strProp("Frame context for selector (frameId or URL substring). With fullPage, clips to the iframe's visible box in the parent viewport."),
```

`wait.props` 加：

```go
		"frame": strProp("Frame to poll text/selector in (frameId or URL substring). url still matches the tab URL."),
```

- [ ] **Step 4: 跑测试**

```bash
cd daemon && go test ./... && go vet ./...
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/mcp daemon/cmd/csi/main.go daemon/cmd/csi/commands.go
git commit -m "MCP 补 list_frames 和 frame 参数，工具表收到 21"
```

---

### Task 4: 扩展 — refs 带 frameId + 生命周期清空

**Files:**
- Modify: `extension/src/background/refs.ts`
- Modify: `extension/src/background/debugger-session.ts`（attach 后 `Page.enable`）
- Modify: `extension/src/background/tools/navigate.ts`（navigate 清空 ref 表）

**Interfaces:**
- Produces:
  - `RefEntry` 增加 `frameId?: string`（空/缺省 = 顶层，协议 §4.1）
  - `assignRef(backendDOMNodeId: number, role: string, name: string, frameId?: string): string`
  - `resetRefs()` 不变
- Consumes（Task 5/6 起）: `lookupRef` 返回的 `entry.frameId`。

- [ ] **Step 1: 改 `refs.ts`**

```ts
export interface RefEntry {
  backendDOMNodeId: number;
  role: string;
  name: string;
  /** 所在帧的 CDP frameId；空/缺省 = 顶层帧（协议 §4.1）。 */
  frameId?: string;
}
```

`assignRef` 加第四参：

```ts
export function assignRef(
  backendDOMNodeId: number,
  role: string,
  name: string,
  frameId?: string,
): string {
  const ref = `e${refCounter++}`;
  refTable.set(ref, { backendDOMNodeId, role, name, frameId });
  return ref;
}
```

文件头注释里「reset on every snapshot」改成「reset on full-page / subtree snapshot, navigation, tab close; frame snapshots append（协议 §4.1）」。

- [ ] **Step 2: attach 时开 Page 域**

`debugger-session.ts` 的 `ensureAttached`，在 `chrome.debugger.attach` 成功后加：

```ts
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
```

（`Page.frameNavigated` 事件要 Page 域开着才有；Task 5 的 frames.ts 靠它清 ref。）

- [ ] **Step 3: navigate 清 ref**

`navigate.ts`：import `resetRefs`，`execute` 开头（校验 url 之后）调 `resetRefs()`，并加一行注释 `// 导航后旧 @e 全部失效（协议 §4.1）`。

- [ ] **Step 4: typecheck + build**

```bash
cd extension && npm run typecheck && npm run build
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add extension/src/background/refs.ts extension/src/background/debugger-session.ts \
  extension/src/background/tools/navigate.ts
git commit -m "@e 记下所在帧，导航和关页把 ref 表清掉"
```

---

### Task 5: 扩展 — frames.ts（发现 ∪、isolated 判定、contextId 表）

**Files:**
- Create: `extension/src/background/frames.ts`

**Interfaces:**
- Consumes: `sendCommand` / `getAttachedTabId`（debugger-session）；`resetRefs`（refs）。
- Produces（Task 6/7/8 全靠这些名字，禁止改）：

```ts
export interface FrameInfo {
  frameId: string;   // isolated 占位帧为 "isolated:<url>"
  parentId: string;  // 顶层为 ""
  url: string;
  name: string;
  isolated: boolean;
}
export const FRAME_GONE_ERROR = 'iframe: frame is gone; run snapshot again';
export function crossOriginError(url: string): Error;
export async function listAllFrames(): Promise<FrameInfo[]>;
export async function findFrame(value: string): Promise<FrameInfo>;   // 抛 no-match/multi-match，不抛 isolated
export async function resolveFrame(value: string): Promise<FrameInfo>; // findFrame + isolated 抛跨域错误
export async function frameById(frameId: string): Promise<FrameInfo>;  // 找不到抛 FRAME_GONE_ERROR
export async function isolatedSrcSet(): Promise<Set<string>>;
export async function contextIdForFrame(frameId: string): Promise<number>;
export function clearFrameCaches(): void;
```

- [ ] **Step 1: 写 `frames.ts`**

文件头注释：「0.6.0 同域 iframe（协议 §4.1）：帧发现（getFrameTree ∪ 顶层 DOM iframe 行 ∪ debugger.getTargets）、isolated 判定（fail closed）、default-world contextId 表。只服务 tab 会话，禁止 attach OOPIF target。」

完整实现：

```ts
import { getAttachedTabId, sendCommand } from './debugger-session';
import { resetRefs } from './refs';

export interface FrameInfo {
  frameId: string;
  parentId: string;
  url: string;
  name: string;
  isolated: boolean;
}

export const FRAME_GONE_ERROR = 'iframe: frame is gone; run snapshot again';

export function crossOriginError(url: string): Error {
  return new Error(
    `iframe: cross-origin frame "${url || 'unknown'}" is not supported yet. ` +
      'If it is a full page, navigate to its URL.',
  );
}

// ---------- 帧发现（规格：发现源不能只靠 getFrameTree） ----------

interface CdpFrame {
  id: string;
  parentId?: string;
  url: string;
  name?: string;
  securityOrigin?: string;
}

interface FrameTreeNode {
  frame: CdpFrame;
  childFrames?: FrameTreeNode[];
}

async function localFrames(): Promise<CdpFrame[]> {
  const { frameTree } = await sendCommand<{ frameTree: FrameTreeNode }>('Page.getFrameTree');
  const out: CdpFrame[] = [];
  const walk = (node: FrameTreeNode): void => {
    out.push(node.frame);
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);
  return out;
}

interface DomIframeRow {
  src: string;
  name: string;
  sandbox: string | null;
  sameDoc: boolean;
}

/** 顶层文档里的 iframe/frame 元素（跨域的 contentDocument 返回 null，不抛）。 */
async function domIframeRows(): Promise<DomIframeRow[]> {
  const res = await sendCommand<{ result?: { value?: DomIframeRow[] } }>('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('iframe,frame')].map((f) => ({
      src: f.src || '',
      name: f.name || f.id || '',
      sandbox: f.getAttribute('sandbox'),
      sameDoc: f.contentDocument != null,
    }))`,
    returnByValue: true,
  });
  return res.result?.value ?? [];
}

/** OOPIF 的 url（type=iframe）。绝不把 targetId 带进返回值（协议 §4）。 */
async function oopifUrls(): Promise<string[]> {
  const tabId = getAttachedTabId();
  const targets = await chrome.debugger.getTargets();
  return targets
    .filter((t) => t.type === 'iframe' && t.tabId === tabId && t.url)
    .map((t) => t.url);
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin; // 不透明源返回 "null"
  } catch {
    return '';
  }
}

// ---------- isolated 判定（fail closed，规格 §扩展实现） ----------

function judgeIsolated(f: CdpFrame, topOrigin: string, row: DomIframeRow | undefined): boolean {
  // 2. 不透明源（sandbox 无 allow-same-origin 的 srcdoc/about:blank、data: 等）
  if (!f.securityOrigin || f.securityOrigin === '://' || f.securityOrigin === 'null') return true;
  if (f.url.startsWith('data:')) return true;
  // sandbox 无 allow-same-origin
  if (row && row.sandbox !== null && !/\ballow-same-origin\b/.test(row.sandbox)) return true;
  // 3. 父页 iframe.contentDocument 不可达（row 只覆盖顶层 iframe；嵌套帧靠 securityOrigin 兜）
  if (row && !row.sameDoc) return true;
  // 4/5. origin 比不出来或不同 → isolated
  if (!topOrigin || topOrigin === 'null') return true;
  return f.securityOrigin !== topOrigin;
}

export async function listAllFrames(): Promise<FrameInfo[]> {
  const [locals, domRows, oopifs] = await Promise.all([
    localFrames(),
    domIframeRows(),
    oopifUrls(),
  ]);
  const top = locals.find((f) => !f.parentId);
  const topOrigin = top ? safeOrigin(top.url) : '';

  const frames: FrameInfo[] = locals.map((f) => {
    const row = f.parentId ? domRows.find((r) => r.src && r.src === f.url) : undefined;
    return {
      frameId: f.id,
      parentId: f.parentId ?? '',
      url: f.url,
      name: f.name || row?.name || '',
      isolated: f.parentId ? judgeIsolated(f, topOrigin, row) : false,
    };
  });

  // 只在 DOM 行 / getTargets 出现的帧 → isolated 占位（不编 CDP frameId）
  const known = new Set(frames.map((f) => f.url));
  for (const row of domRows) {
    if (row.src && !known.has(row.src)) {
      frames.push({ frameId: `isolated:${row.src}`, parentId: top?.id ?? '', url: row.src, name: row.name, isolated: true });
      known.add(row.src);
    }
  }
  for (const url of oopifs) {
    if (!known.has(url)) {
      frames.push({ frameId: `isolated:${url}`, parentId: top?.id ?? '', url, name: '', isolated: true });
      known.add(url);
    }
  }
  return frames;
}

// ---------- 帧解析 ----------

/** 匹配帧（不含顶层）：先 frameId 精确，再未截断 URL 子串。不抛 isolated。 */
export async function findFrame(value: string): Promise<FrameInfo> {
  const all = (await listAllFrames()).filter((f) => f.parentId !== '' || f.frameId.startsWith('isolated:'));
  const exact = all.filter((f) => f.frameId === value);
  const hits = exact.length > 0 ? exact : all.filter((f) => f.url.includes(value));
  if (hits.length === 0) throw new Error(`iframe: no frame matching "${value}"`);
  if (hits.length > 1) {
    const urls = hits.slice(0, 5).map((f) => f.url).join(', ');
    throw new Error(`iframe: multiple frames match "${value}": ${urls}`);
  }
  return hits[0]!;
}

export async function resolveFrame(value: string): Promise<FrameInfo> {
  const f = await findFrame(value);
  if (f.isolated) throw crossOriginError(f.url);
  return f;
}

export async function frameById(frameId: string): Promise<FrameInfo> {
  const f = (await listAllFrames()).find((x) => x.frameId === frameId);
  if (!f) throw new Error(FRAME_GONE_ERROR);
  return f;
}

export async function isolatedSrcSet(): Promise<Set<string>> {
  const all = await listAllFrames();
  return new Set(all.filter((f) => f.isolated && f.url).map((f) => f.url));
}

// ---------- default-world contextId 表（规格 §ref 表） ----------

const contextByFrame = new Map<string, number>();
const contextWaiters = new Map<string, ((id: number) => void)[]>();

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null || source.tabId !== getAttachedTabId()) return;
  if (method === 'Runtime.executionContextCreated') {
    const ctx = (params as {
      context?: { id?: number; auxData?: { frameId?: string; isDefault?: boolean } };
    }).context;
    const frameId = ctx?.auxData?.frameId;
    if (ctx?.id != null && frameId && ctx.auxData?.isDefault) {
      contextByFrame.set(frameId, ctx.id);
      const waiters = contextWaiters.get(frameId) ?? [];
      contextWaiters.delete(frameId);
      for (const w of waiters) w(ctx.id);
    }
  } else if (method === 'Runtime.executionContextsCleared') {
    contextByFrame.clear();
  } else if (method === 'Page.frameNavigated') {
    const frame = (params as { frame?: { parentId?: string } }).frame;
    if (frame && !frame.parentId) {
      // 主文档 commit 导航：ref 表与 context 表作废（协议 §4.1）
      resetRefs();
      clearFrameCaches();
    }
  }
});

chrome.tabs.onRemoved.addListener(() => {
  resetRefs();
  clearFrameCaches();
});

chrome.debugger.onDetach.addListener(() => {
  resetRefs();
  clearFrameCaches();
});

export function clearFrameCaches(): void {
  contextByFrame.clear();
}

/**
 * 该帧 default world 的 executionContextId。MV3 SW 可能丢事件：
 * 缓存未命中时 disable→enable 让 Runtime 重发 executionContextCreated；
 * 再拿不到才退到 Page.createIsolatedWorld（fill/click 看不到页面 JS，仅兜底）。
 */
export async function contextIdForFrame(frameId: string): Promise<number> {
  const cached = contextByFrame.get(frameId);
  if (cached != null) return cached;

  const waiting = new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 1000);
    const list = contextWaiters.get(frameId) ?? [];
    list.push((id) => {
      clearTimeout(timer);
      resolve(id);
    });
    contextWaiters.set(frameId, list);
  });
  await sendCommand('Runtime.disable');
  await sendCommand('Runtime.enable');
  const refreshed = await waiting;
  if (refreshed != null) return refreshed;

  const { executionContextId } = await sendCommand<{ executionContextId: number }>(
    'Page.createIsolatedWorld',
    { frameId, worldName: 'csi-frame', grantUniveralAccess: true },
  );
  return executionContextId;
}
```

注意：`Runtime.disable` 会触发 `executionContextsCleared` 清表，随后 `enable` 重发，这是刻意的刷新路径，不要「优化」掉。

- [ ] **Step 2: typecheck + build**

```bash
cd extension && npm run typecheck && npm run build
```

Expected: PASS（暂无调用方，下一任务接上）。

- [ ] **Step 3: 提交**

```bash
git add extension/src/background/frames.ts
git commit -m "帧发现三路并集，isolated 拿不准就算跨域"
```

---

### Task 6: 扩展 — snapshot 进框 + iframe 行 `@e` / `[isolated]`

**Files:**
- Modify: `extension/src/background/tools/ax-yaml.ts`
- Modify: `extension/src/background/tools/snapshot.ts`
- Modify: `extension/src/background/tools/element.ts`

**Interfaces:**
- Consumes: Task 4 的 `assignRef(..., frameId?)`；Task 5 的 frames.ts 全部导出。
- Produces:
  - `compactFromAx(nodes, mode, includeRoot?, frameId?, isolatedSrcs?)`（加第 4/5 参）
  - `CompactNode.isolated?: boolean`
  - `resolveObjectId(toolName: string, selector: string, frameId?: string): Promise<string>`
  - `parseFrameArg(toolName: string, raw: unknown): string | undefined`
  - snapshot 进帧返回 `{url, title, mode, chars, truncated, tree}`，url/title 为该帧

- [ ] **Step 1: 改 `element.ts`**

`resolveObjectId` 加第三参，CSS 路径有 frameId 时进该帧 default world；ref 路径不变（`DOM.resolveNode` 不带 `executionContextId`，Blink 按 node 所在 LocalFrame 的 main world 解析——协议 §4.1），但 ref 解析失败且 ref 带 `frameId` 时报帧没了：

```ts
import { contextIdForFrame, FRAME_GONE_ERROR } from '../frames';

export async function resolveObjectId(
  toolName: string,
  selector: string,
  frameId?: string,
): Promise<string> {
  return isRefSelector(selector)
    ? objectIdFromRef(toolName, selector)
    : objectIdFromCss(toolName, selector, frameId);
}

async function objectIdFromRef(toolName: string, selector: string): Promise<string> {
  const entry = lookupRef(selector);
  if (!entry) {
    throw new Error(`${toolName}: unknown ref "${selector}". Run snapshot first to get refs.`);
  }
  const { object } = await sendCommand<{ object?: { objectId?: string } }>('DOM.resolveNode', {
    backendNodeId: entry.backendDOMNodeId,
  });
  if (!object?.objectId) {
    if (entry.frameId) throw new Error(FRAME_GONE_ERROR);
    throw new Error(`${toolName}: could not resolve ref "${selector}" to DOM element`);
  }
  return object.objectId;
}

async function objectIdFromCss(
  toolName: string,
  selector: string,
  frameId?: string,
): Promise<string> {
  const params: Record<string, unknown> = {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  };
  if (frameId) params.contextId = await contextIdForFrame(frameId);
  const result = await sendCommand<{
    exceptionDetails?: { text: string };
    result: { subtype?: string; objectId?: string };
  }>('Runtime.evaluate', params);
  // ...以下与原实现相同（exceptionDetails / null 检查 / return objectId）
}
```

新增导出（7 个工具 + snapshot 共用）：

```ts
/** 解析可选 frame 参数：null/缺省/空字符串 = 未传；非字符串真值报错（协议 §3.3）。 */
export function parseFrameArg(toolName: string, raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new Error(`${toolName}: frame must be a string (frameId or URL substring)`);
  }
  return raw;
}
```

- [ ] **Step 2: 改 `ax-yaml.ts`**

1. `CompactNode` 加 `isolated?: boolean`。`STRUCTURAL_ROLES` 加 `'frame'`。
2. `compactFromAx` 签名改：

```ts
export function compactFromAx(
  nodes: AxNode[],
  mode: 'compact' | 'interactive',
  includeRoot = false,
  frameId?: string,
  isolatedSrcs?: Set<string>,
): CompactNode[] {
```

`frameId` / `isolatedSrcs` 透传进 `formatNode` / `collectChildren`（两个 helper 各加这两个参数，递归处原样下传）。

3. `formatNode` 里 iframe/frame 的处理（紧跟现有 `if (role === 'iframe' || role === 'img')` 的 src 块之后）：

```ts
  const isFrameRole = role === 'iframe' || role === 'frame';
  if (isFrameRole && node.backendDOMNodeId != null) {
    // iframe/frame 也进 ref 表（协议 §4.1：snapshot({selector:"@eN"}) 进框入口）
    result.ref = `@${assignRef(node.backendDOMNodeId, role, name, frameId)}`;
    const full = axString(propValue(node, 'url'));
    if (full && isolatedSrcs?.has(full)) result.isolated = true;
  }
```

（原 `if (isInteractive) { result.ref = ... }` 保留，改成 `assignRef(..., frameId)` 带第四参。）

4. `formatLine`：在 `if (node.invalid)` 之后、`if (node.src)` 之前插一行：

```ts
  if (node.isolated) parts.push('[isolated]');
```

（固定属性顺序 = 协议 §4.1：name、level、checked、selected、expanded、disabled、invalid、isolated、src、ref、value。）

5. 文件头 Example 1 的输出改成带 ref：

```
 *   - iframe "reCAPTCHA" [src=https://www.google.com/recaptcha/…] [isolated] [ref=@e2]
```

- [ ] **Step 3: 改 `snapshot.ts`**

`execute` 重排（保留 parseMode / parseMaxChars）：

```ts
    const selector =
      typeof args.selector === 'string' && args.selector.length > 0 ? args.selector : undefined;
    const frameArg = parseFrameArg(this.name, args.frame);

    const tab = await getCurrentTab();
    await ensureAttached(tab.id!);

    // frame= 先解析（0 命中/多命中/跨域错误在这里抛，协议 §4.1）。
    // @e 的 selector 忽略它（ref 表自带 frameId），CSS 的 selector 在该帧里找。
    let preFrame: FrameInfo | undefined;
    if (frameArg) preFrame = await resolveFrame(frameArg);

    // selector 在 resetRefs 之前解析，旧快照的 @e 仍可用。
    let backendNodeId: number | undefined;
    let targetFrame: FrameInfo | undefined;
    if (selector) {
      const objectId = await resolveObjectId('snapshot', selector, preFrame?.frameId);
      const described = await sendCommand<{
        node?: { backendNodeId?: number; nodeName?: string; frameId?: string };
      }>('DOM.describeNode', { objectId });
      const node = described.node;
      const nodeName = (node?.nodeName ?? '').toUpperCase();
      if (nodeName === 'IFRAME' || nodeName === 'FRAME') {
        // 入口 1：selector 指向 iframe/frame → 拍它的子帧
        if (!node?.frameId) throw new Error(FRAME_GONE_ERROR);
        targetFrame = await frameById(node.frameId);
        if (preFrame && preFrame.frameId !== targetFrame.frameId) {
          throw new Error('iframe: selector and frame do not refer to the same frame');
        }
        if (targetFrame.isolated) throw crossOriginError(targetFrame.url);
      } else {
        backendNodeId = node?.backendNodeId;
        if (backendNodeId == null) {
          throw new Error(`snapshot: element not found: ${selector}`);
        }
        targetFrame = preFrame; // 帧内子树（协议 §4.1）
      }
    } else if (preFrame) {
      targetFrame = preFrame; // 入口 2：frame= 直接进
    }

    const isFrameEntry = targetFrame != null && backendNodeId == null;
    if (!isFrameEntry) resetRefs(); // 整页与普通子树 reset；进帧 snapshot 追加（协议 §4.1）

    const axParams = targetFrame ? { frameId: targetFrame.frameId } : undefined;
    let nodes: AxNode[];
    try {
      ({ nodes } = await sendCommand<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', axParams));
    } catch (err) {
      if (targetFrame?.isolated) throw crossOriginError(targetFrame.url);
      if (targetFrame) throw new Error(FRAME_GONE_ERROR);
      throw err;
    }
    const isolatedSrcs = await isolatedSrcSet();
```

之后：

- `subtreeRoot` 逻辑不变（`backendNodeId` 在 `nodes` 里找）。
- `mode === 'full'`：`buildTree(nodes, subtreeRoot, targetFrame?.frameId)`——`buildTree` 加第三参，`assignRef` 处带第四参；iframe/frame 角色在 full 模式同样 `assignRef`（与 compact 对齐）。`url`/`title` 见下。
- compact：`compactFromAx(axNodes, mode, Boolean(compactRoot), targetFrame?.frameId, isolatedSrcs)`。
- 返回的 `url` / `title`：有 `targetFrame` → `url: targetFrame.url`，`title` 用 `contextIdForFrame` + `Runtime.evaluate('document.title', { contextId })` 取（异常 → `''`）；没有 → `tab.url` / `tab.title` 照旧。

import 更新：`parseFrameArg`（element）、`resolveFrame` / `frameById` / `crossOriginError` / `isolatedSrcSet` / `contextIdForFrame` / `FRAME_GONE_ERROR` / `FrameInfo`（frames）。

- [ ] **Step 4: typecheck + build**

```bash
cd extension && npm run typecheck && npm run build
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add extension/src/background/tools/ax-yaml.ts extension/src/background/tools/snapshot.ts \
  extension/src/background/tools/element.ts
git commit -m "snapshot 能进同域 iframe，父页那行给 @e，跨域标 isolated"
```

---

### Task 7: 扩展 — list_frames 工具

**Files:**
- Create: `extension/src/background/tools/list-frames.ts`
- Modify: `extension/src/background/registry.ts`
- Modify: `extension/src/background/index.ts`（文件头 20→21）

**Interfaces:**
- Consumes: `listAllFrames`（Task 5）。
- Produces: `ListFramesTool.name === "list_frames"`，返回 `{ success:true, frames: [{frameId,parentId,url,name,isolated}] }`。

- [ ] **Step 1: 写 `list-frames.ts`**

```ts
/**
 * list_frames (protocol §4.21): 当前 tab 的全部帧（含顶层，parentId ""）。
 * isolated:true 的帧本期进不去（跨域 OOPIF / 不透明源 / sandbox）。
 * 输出禁止出现 targetId / session id（协议 §4）。
 */
import type { ToolArgs } from '../../shared/messages';
import type { Tool } from './types';
import { ensureAttached } from '../debugger-session';
import { getCurrentTab } from '../tab-manager';
import { listAllFrames } from '../frames';

export class ListFramesTool implements Tool {
  readonly name = 'list_frames';

  async execute(_args: ToolArgs): Promise<unknown> {
    await ensureAttached((await getCurrentTab()).id!);
    const frames = await listAllFrames();
    return {
      success: true,
      frames: frames.map((f) => ({
        frameId: f.frameId,
        parentId: f.parentId,
        url: f.url,
        name: f.name,
        isolated: f.isolated,
      })),
    };
  }
}
```

- [ ] **Step 2: 注册**

`registry.ts`：import + `register(new ListFramesTool());`（放 `ListTabsTool` 附近）。**不要**进 `SESSION_SCOPED_TOOLS`（它作用在当前 tab）。`index.ts` 文件头「registers the 20 tools」→ 21。

- [ ] **Step 3: typecheck + build**

```bash
cd extension && npm run typecheck && npm run build
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add extension/src/background/tools/list-frames.ts extension/src/background/registry.ts \
  extension/src/background/index.ts
git commit -m "加 list_frames：跨域的也列得出，就是进不去"
```

---

### Task 8: 扩展 — 七个工具的 `frame` 参数

**Files:**
- Modify: `extension/src/background/tools/click.ts`
- Modify: `extension/src/background/tools/fill.ts`
- Modify: `extension/src/background/tools/evaluate.ts`
- Modify: `extension/src/background/tools/mouse-click.ts`
- Modify: `extension/src/background/tools/hover.ts`
- Modify: `extension/src/background/tools/screenshot.ts`
- Modify: `extension/src/background/tools/wait.ts`

**Interfaces:**
- Consumes: `parseFrameArg` / `resolveObjectId(name, selector, frameId?)`（Task 6）、`resolveFrame` / `contextIdForFrame`（Task 5）。
- Produces: 七工具接受可选 `frame`；`@e` 一律忽略 `frame`（协议 §4.1）。

共同模式（每个工具 execute 里）：

```ts
const frameArg = parseFrameArg(this.name, args.frame);
// @e 忽略 frame；CSS/evaluate 才解析
const selector = ...;
const frameId =
  frameArg && !(selector && isRefSelector(selector))
    ? (await resolveFrame(frameArg)).frameId
    : undefined;
```

- [ ] **Step 1: click.ts / fill.ts**

- `clickBySelector(selector, frameId?)` / `fillBySelector(selector, value, frameId?)`：`Runtime.evaluate` 的 params 加 `...(frameId ? { contextId: await contextIdForFrame(frameId) } : {})`。
- `clickByRef` / `fillByRef` 不动（ref 自带帧）。
- execute：`isRefSelector(selector) ? this.clickByRef(selector) : this.clickBySelector(selector, frameId)`（fill 同理）。

- [ ] **Step 2: evaluate.ts**

```ts
const frameArg = parseFrameArg(this.name, args.frame);
const params: Record<string, unknown> = {
  expression: code,
  returnByValue: true,
  awaitPromise: true,
};
if (frameArg) params.contextId = await contextIdForFrame((await resolveFrame(frameArg)).frameId);
```

（evaluate 没有 selector，直接解析 frame。）

- [ ] **Step 3: mouse-click.ts / hover.ts**

`resolveObjectId(this.name, selector, frameId)`。其余不动。**坐标不要加 iframe offset**——`DOM.getBoxModel` 已是根视口 CSS 像素（协议 §4.1），在两处文件头注释各补一句：「frame 内元素坐标同样是根视口像素，禁止累加 iframe 盒」。

- [ ] **Step 4: screenshot.ts**

- selector 路径：`resolveObjectId(this.name, selector, frameId)`。
- `fullPage && frameArg`（无 selector）：clip 到该 iframe 元素在父页视口里的可见盒，**不开** `captureBeyondViewport`：

```ts
const frameId = (await resolveFrame(frameArg)).frameId;
const { backendNodeId } = await sendCommand<{ backendNodeId: number }>(
  'DOM.getFrameOwner',
  { frameId },
);
const { object } = await sendCommand<{ object?: { objectId?: string } }>('DOM.resolveNode', {
  backendNodeId,
});
if (!object?.objectId) throw new Error(FRAME_GONE_ERROR);
// 之后与 selector 路径相同：getBoxModel → border → clip（scale:1）
```

- `fullPage && selector` 互斥检查保留在最前；`fullPage + frame + selector` 三件套同样被互斥挡掉。

- [ ] **Step 5: wait.ts**

- `frameArg` 在进循环**之前**解析成 `frameId`（`resolveFrame` 的错误要立刻抛，不能被轮询吃掉）：`selector` 是 `@e` 时 `frameId = undefined`。
- `check(kind, value, currentId, frameId?)` 透传：`checkText(needle, frameId)`——`Runtime.evaluate` 加 contextId（有 frameId 时），AX 兜底改 `Accessibility.getFullAXTree(frameId ? { frameId } : undefined)`；`checkSelector(value, frameId)`——CSS 分支 evaluate 加 contextId，`@e` 分支照旧。
- `url` 分支不动（仍看 tab URL，协议 §4.1）。
- 注意 `check` 的 try/catch 会把帧消失变成 false 继续轮询直到超时——这是要的（页面可能正在重排）；`resolveFrame` 在循环外，错误照常抛。

- [ ] **Step 6: typecheck + build**

```bash
cd extension && npm run typecheck && npm run build
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add extension/src/background/tools/click.ts extension/src/background/tools/fill.ts \
  extension/src/background/tools/evaluate.ts extension/src/background/tools/mouse-click.ts \
  extension/src/background/tools/hover.ts extension/src/background/tools/screenshot.ts \
  extension/src/background/tools/wait.ts
git commit -m "click/fill/evaluate 等七个工具认 frame，@e 照旧自带帧"
```

---

### Task 9: 技能、文档、宣传页清单对齐

**Files:**
- Modify: `skills/csi/SKILL.md`
- Modify: `skills/csi/references/operations.md`
- Modify: `.claude/rules/protocol-sync.md`（「20 个」→「21 个」）
- Modify: `README.md`、`README.zh-CN.md`（20 → 21，加 `list_frames`）
- Modify: `extension/CLAUDE.md`、`daemon/internal/mcp/server.go` 之外的残留：用 `git grep -n '20 个工具\|20 tools\|20 件' ` 扫一遍补齐
- Modify: `site/src/data/tools.ts`、`site/src/i18n/zh.ts`、`site/src/i18n/en.ts`

**Interfaces:**
- SKILL 表必须与 protocol §4 的 21 个名字一致。

- [ ] **Step 1: SKILL.md 工具表**

`snapshot` 行 args 加 `frame`；`evaluate`/`click`/`fill`/`mouse_click`/`hover`/`screenshot`/`wait` 行 args 加可选 `frame`。表尾（`close_session` 后）加：

```
| `list_frames` | — | `{success, frames:[{frameId,parentId,url,name,isolated}]}` | 列当前 tab 全部帧（含顶层）。辅助工具：歧义排查、看 name/完整 URL/isolated。**不是**进框前置步骤 |
```

- [ ] **Step 2: SKILL.md 加 iframe 一节 + 改 Known limitations**

在「Prefer snapshot over CSS/JS selectors」节后加「## Iframes」：

- 整页 snapshot 里 iframe 仍是一行（不下行），但带 `[ref=@eN]`；跨域行带 `[isolated]`。
- 同域 iframe 行（**没有** `[isolated]`）：对该 `@e` 再 `snapshot`（`selector` 传那个 ref），返回只含那一帧的 YAML，里面的控件带新 `@e`，直接 click/fill。进框后父页旧 `@e` 仍然有效；点父页失败再重拍父页，不要每次进出都重拍。
- 或 `snapshot({frame: "<未截断 URL 子串或 frameId>"})`。嵌套场景已知内层完整 URL 时可跳过中间层。**不要**用行里截到 80 字符的 `src` 当 `frame=`；优先 `@e`。**不要**编造 CDP frameId。
- 之后 click/fill/hover/mouse_click/wait/screenshot **不必**传 `frame`（`@e` 自带帧）；只有 CSS 选择器 / `evaluate` 要进帧时才传 `frame=`。
- `[isolated]` 行：本期进不去。src 是完整页面就 `navigate` 进去；否则告诉用户这期不支持跨域框。对 isolated 帧 snapshot/click 会得到 `iframe: cross-origin frame ...`。
- `list_frames` 只在需要排查时用（`frame=` 多命中、看 `name`、看完整 URL / `isolated`），不是每次进框的前置。
- `/status.version` < 0.6.0 或 `extension_tools` 没有 `list_frames`：不要对 iframe `@e` 再 snapshot（旧扩展会拍空壳），退回 `navigate` 进 src。

Known limitations 的 iframe 条改成：

```
- **Cross-origin iframes**: 0.6 只列出（`[isolated]` / `list_frames` 的 `isolated:true`），进不去；整页型嵌入请 navigate 进 iframe URL。同域 iframe 可直接进入 — see [Iframes](#iframes)。
```

- [ ] **Step 3: operations.md**

「version mismatch」段第 1 条扩成：

1. If the error contains `does not implement` (including `"list_frames"` or `"frame"`, need ≥ 0.6.0) → tell the user to upgrade the extension (Chrome Web Store, or reload `~/.csi/extension`). Do not start/stop/restart.
2. If the error is `unknown tool` and `/status.version` is < 0.6.0 → tell the user to upgrade the daemon (GitHub Release / installer).
3. 不要自己「对齐版本」。

- [ ] **Step 4: README / protocol-sync / 站点**

- `README.md:196` 与 `README.zh-CN.md:196`：「20 tools / 20 个工具」→ 21，列表 `close_session` 后加 `list_frames`。`README.zh-CN.md:104`「全部 20 个」→ 21。README 里如有 iframe 限制描述，同步成「同域可进、跨域只列不进」。
- `.claude/rules/protocol-sync.md`：「当前 20 个」→「当前 21 个」。
- `extension/CLAUDE.md`：「协议 §4 的 20 个工具」→ 21。
- `site/src/data/tools.ts`：`close_session` 后加一行：

```ts
  { name: 'list_frames', zh: '列出全部帧，跨域标 isolated', en: 'List all frames; cross-origin marked isolated' },
```

- `site/src/i18n/zh.ts` / `en.ts`：`ctaTools`「20」→「21」、`tools.title`「20 件」→「21 件」等；用 `grep -n '20' site/src/i18n` 找齐（`@e17` 之类的 ref 编号不要动）。英文 FAQ 里「includes 20 tools」→ 21。

- [ ] **Step 5: 提交**

```bash
git add skills .claude/rules/protocol-sync.md README.md README.zh-CN.md \
  extension/CLAUDE.md site/src
git commit -m "技能学会同域 iframe 主路，文档清单齐到 21"
```

---

### Task 10: 版本号 0.6.0 + 手测夹具验收

**Files:**
- Modify: `daemon/internal/version/version.go` → `"0.6.0"`
- Modify: `daemon/internal/server/server_test.go` 两处 `"0.5.0"` 断言 → `"0.6.0"`
- Modify: `extension/manifest.json`、`extension/package.json`、`package.json`、`site/package.json`
- Modify: `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`.codex-plugin/plugin.json`、`.cursor-plugin/plugin.json`、`.kimi-plugin/plugin.json`
- Modify: `skills/csi/SKILL.md`、`skills/csi-e2e/SKILL.md` 的 `metadata.version`
- Modify: `site/src/i18n/zh.ts` / `en.ts` 的 `footer.version` → `v0.6.0`
- Modify: `store/UPLOAD.md` 的 `csi-extension-v0.5.0.zip` → `v0.6.0`（两处）
- 改完 `package.json` 后在 `extension/` 与 `site/` 各跑一次 `npm install --package-lock-only` 同步 lock
- 兜底：`git grep -n '0\.5\.0'` 扫一遍，docs/superpowers 下的历史规格/计划不要动

不打 git tag（发版用户再说）。

- [ ] **Step 1: 改版本字符串 + 全量测试**

```bash
cd daemon && go test ./... && go vet ./...
cd ../extension && npm run typecheck && npm run build
```

Expected: PASS。

- [ ] **Step 2: 手测夹具**

写两个夹具页到 `/tmp/csi-iframe-fixture/`：

`parent.html`：

```html
<!doctype html><title>iframe fixture parent</title>
<h1>parent page</h1>
<button id="parent-btn" onclick="document.getElementById('parent-out').textContent='parent clicked'">Parent button</button>
<span id="parent-out"></span>
<iframe name="inner" src="/inner.html" width="400" height="200"></iframe>
<iframe name="inner2" src="/inner.html?copy=1" width="400" height="200"></iframe>
```

`inner.html`：

```html
<!doctype html><title>inner frame</title>
<button id="inner-btn" onclick="document.getElementById('inner-out').textContent='inner clicked'">Inner button</button>
<span id="inner-out"></span>
<input id="inner-input" type="text">
```

`cross.html`（同目录，由 8931 端口伺服，嵌 8932 端口的页——端口不同即跨域）：

```html
<!doctype html><title>cross fixture</title>
<iframe name="xo" src="http://127.0.0.1:8932/inner.html" width="400" height="200"></iframe>
```

起服务 + 全新构建：

```bash
cd /tmp/csi-iframe-fixture && python3 -m http.server 8931 & python3 -m http.server 8932 &
cd daemon && go build -o ~/.csi/bin/csi ./cmd/csi && ~/.csi/bin/csi restart
# chrome://extensions 里 reload extension/dist
```

验收清单（对照规格 §成功标准）：

1. `curl /status` → `version=0.6.0`，`extension_version=0.6.0`，`extension_tools` 含 `list_frames`。
2. `navigate` 到 `http://127.0.0.1:8931/parent.html` → 整页 `snapshot`：两条 iframe 行都带 `[ref=@eN]`、**无** `[isolated]`、**看不到** Inner button；token 量与 0.4 相当。
3. `snapshot` `selector=@e<第一条 iframe 的 ref>` → YAML 里有 `button "Inner button"` 和 `textbox`，带新 `@e`；`url` 是 inner.html，`title` 是 `inner frame`。
4. `click` 那个 Inner button 的 `@e` → 成功；`evaluate` `{"code":"document.getElementById('inner-out').textContent","frame":"/inner.html"}` → `inner clicked`。
5. `mouse_click` 另一个帧内元素（重拍拿 ref）→ 同样成功：**坐标不加 offset** 的直接证据（点在框内正确位置，偏了就是双重偏移）。
6. 点父页：对第 2 步 Parent button 的旧 `@e` `click`（**不重拍**）→ 成功（进框不清 ref）。
7. `snapshot` `{"frame":"inner.html"}` → error `iframe: multiple frames match "inner.html": ...`（列两个候选）。
8. `snapshot` `{"frame":"no-such-frame"}` → `iframe: no frame matching "no-such-frame"`。
9. `navigate` 到 `http://127.0.0.1:8931/cross.html` → `snapshot`：iframe 行带 `[isolated]`；对该 `@e` 再 snapshot → `iframe: cross-origin frame "http://127.0.0.1:8932/inner.html" is not supported yet. If it is a full page, navigate to its URL.`；`list_frames` → 该帧 `isolated:true`、无 targetId 字段。
10. 混合版本（可选）：临时 reload 一只旧 dist（0.5.0）→ `snapshot` 带 `frame` 返回 `does not implement "frame"`，`list_frames` 返回 `does not implement "list_frames"`，daemon 日志无对应 tool_call。

禁止拿真实 Stripe/recaptcha 当成功标准（规格 §测试）。

- [ ] **Step 3: 提交**

```bash
git add daemon/internal/version/version.go daemon/internal/server/server_test.go \
  extension/manifest.json extension/package.json extension/package-lock.json \
  package.json site/package.json site/package-lock.json site/src/i18n \
  .claude-plugin .codex-plugin .cursor-plugin .kimi-plugin skills store/UPLOAD.md
git commit -m "版本 0.6.0：同域 iframe 能进了"
```

---

## Spec coverage（自检）

| 规格条款 | 任务 |
|---|---|
| 目标 1 同域进框（snapshot 再拍 / click/fill/wait） | Task 6、8 |
| 目标 2 跨域列得出进不去、稳定英文错误 | Task 5、6、7 |
| 目标 3 整页 token 同量级（仍一行、不下行） | Task 6（ax-yaml 仍剪子孙） |
| 目标 4 进框后父页 `@e` 还在（不 reset） | Task 4、6 |
| Agent 主路（`@e` 优先、`frame=`、只下一层、跳中间层） | Task 6、9 |
| 协议：snapshot `frame`、入口判定三条、错误文案六条 | Task 1、5、6 |
| 其它七工具 `frame`（`@e` 忽略、CSS/evaluate 进帧、fullPage+frame clip、wait url 看 tab） | Task 8 |
| list_frames（发现源三路并集、占位 frameId、禁 targetId、toolSince 0.6.0） | Task 2、5、7 |
| 混合版本 frame 闸（非字符串真值、semver、缺 tools 视为不够、未连接不拦） | Task 2 |
| ref 表（frameId、reset 规则三条、resolveNode 不带 context、contextId 表可刷新、生命周期清空） | Task 4、5、6 |
| 扩展实现（tab attach 不动、isolated fail closed 五条、getFullAXTree({frameId})、坐标不加 offset） | Task 4、5、6、8 |
| 技能（Prefer snapshot、isolated 处理、不编 frameId、known limitations、operations） | Task 9 |
| 测试（daemon 单测、扩展 typecheck/build + 夹具手测、禁真实 Stripe/recaptcha） | Task 2、10 |
| 版本与兼容（0.6.0 最后改、中间保持 0.5.0、不打 tag、商店另传） | Task 10 |

## 不要做

- 不要 attach OOPIF `targetId`、不要 `Target.setAutoAttach` flatten。
- 不要给扩展加测试框架。
- 不要设 `descend_frames` / 展平所有帧。
- 不要把 `targetId` / session id 出现在任何对外返回里。
- 不要做 `handle_dialog`、下载、`downloads` 权限。
- 不要改 loopback / 加鉴权。
- 不要在本计划里打 `v0.6.0` tag。
- 不要把 srcdoc / about:blank 一律当同域（有 sandbox 时是错的，fail closed）。
- 坐标不要加 iframe offset（嵌套同域也不加；OOPIF 会话那期才累加）。
