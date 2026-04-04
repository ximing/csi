# 0.6.0 同域 iframe 穿透

日期：2026-04-04
状态：待确认
版本：0.6.0（协议 bump）。本文件取代 `2026-03-30-agent-reliability-design.md` 的 **C.1**。C.2 对话框、C.3 下载仍在那份里，**不在本期**。

可行性与成本审查（2026-04-04）：同域、未 sandbox 的 iframe 在 `chrome.debugger.attach({tabId})` 上可行；默认不下行则 token 与 0.4 同量级，进框比 `navigate` 进 src 更省轮数。下列条款已吸收审查结论（坐标、isolated 判定、`list_frames` 发现源、iframe `@e`）。

## 背景

0.4 compact snapshot 把 iframe 收成一行 `src`，不下行，且 **不给 `@e`**（只是结构角色）。技能退路是 `navigate` 进 iframe URL。这对「整页被嵌进去」勉强能用；对同域后台套的框，agent 看得见进不去。跨域 OOPIF（Stripe、多数 OAuth/支付窗、recaptcha）是另一套 CDP（要对 iframe `targetId` attach），实现和坐标换算都更重。

本期只打同域，把 API 做成以后补跨域也不改形状。默认 snapshot **不**自动下行——否则广告/验证码会把 24k YAML 打爆。进框多 1 次只含那一帧的 snapshot，通常比 0.4 的 navigate + 整页 YAML 更便宜。

## 目标

1. 同域 iframe：对那一行再 `snapshot` 一次，即可 click/fill/wait，不必新开 tab。
2. 跨域 iframe：列得出、进不去，错误是稳定英文，不给空树装成功。
3. 整页 snapshot 的 token 与 0.4 同量级（仍一行 iframe，不带子控件）。进框多 1 次 snapshot，只含那一帧。
4. 进框后父页 `@e` 还在，不必为了点回父页再拍一次整页。

## 非目标

- 不 attach OOPIF `targetId`（留给 0.6.x / 0.7）。tab 会话 `getFullAXTree({frameId})` 失败时 **禁止** 改成 attach target 混过去。
- 不设 `descend_frames`，不把所有 frame 展平进一次 snapshot。
- 不做 `handle_dialog`、不做下载、不申请 `downloads` 权限。
- 不改安全边界（仍 `127.0.0.1`，v1 无鉴权）。
- 不把 `targetId` 暴露给调用方。
- 不自动 `navigate` 进 iframe src。
- 技能 **不必** 先 `list_frames` 再进框（避免 happy path 白加一轮）。

## 成功标准

1. 同域夹具页：父 `snapshot` 有 iframe 行、带 `[ref=@e…]`、无框内控件；对该 `@e` 再 snapshot，YAML 里出现框内 button/textbox 且带新 `@e`；随后 `click` 那个 ref 成功。
2. 跨域 iframe：父 snapshot 的 iframe 行带 `[isolated]`；`snapshot({frame})` / 对跨域 iframe `@e` 再 snapshot / 带 `frame=` 的 click，返回下文 `iframe: cross-origin…`；`list_frames` 对该帧 `isolated: true`。
3. `frame=` URL 子串命中多个帧 → 失败并列候选，不默进第一个。
4. 进框 snapshot 之后，父页上一个 `@e` 仍能 click。
5. 0.5 扩展 + 0.6 daemon：调用 `list_frames`，或任一工具带非空 `frame`（含非字符串真值），走 §3.3 同构的 `does not implement`，不把 `frame` 丢掉后误操作顶层。

## Agent 主路

默认 `snapshot` 与 0.4 相同：**不下行**（iframe 子孙剪掉）。与 0.4 的差别：iframe / frame 节点 **分配 `@e`**；跨域行加 `[isolated]`。

```
- iframe "payment" [src=https://pay.example.com/checkout] [isolated] [ref=@e3]
- iframe "nav" [src=https://admin.same-origin.example/nav] [ref=@e4]
```

`src` 仍截到 80 字符（0.4）。因此进框 **优先 `@e`**，不要用截断后的 src 当 `frame=` 子串。

进某一框（happy path **不必** `list_frames`）：

- `snapshot({ selector: "@e4" })` 且 `@e4` 是 iframe/frame → 拍那一帧
- 或 `snapshot({ frame: "<未截断的 URL 子串或 frameId>" })`

只下一层。框里若还有 iframe，仍是一行（带自己的 `@e`），再 snapshot 才进。若已经知道内层完整 URL，允许 `snapshot({ frame: innerUrl })` **跳过中间层**，不要为此自动展平树。

之后 `click` / `fill` / `hover` / `mouse_click` / `wait` / `screenshot` **不必传 frame**。`@e` 自带 `frameId`。调用方再传 `frame=` 也忽略，以 ref 表为准。

CSS 选择器默认顶层。要在某帧里用 CSS，必须显式 `frame=`。

`list_frames` 是辅助：歧义 `frame=`、看 `name`、看完整 URL / `isolated`。不要写成每次进框的前置步骤。

整页型嵌入以及 `[isolated]` 行：技能才允许 `navigate` 进 src。

## 协议

工具数 20 → 21。先改 `docs/protocol.md`，再改 `validTools`、MCP `toolDefs`、扩展 registry、`skills/csi/SKILL.md`。

### snapshot

现有 `mode` / `selector` / `max_chars` 不变。新增：

| 字段 | 类型 | 含义 |
|---|---|---|
| `frame` | string | 可选。CDP `frameId` **或** URL 子串。与「selector 指向 iframe」二选一作为进框入口；两者同时出现见下。 |

进框时返回形状仍是 `{url, title, mode, chars, truncated, tree}`。`url` / `title` 用 **那一帧** 的（frame URL；title 没有就空字符串）。`tree` 是那一帧的 compact YAML（或 `mode=full` 的 JSON 数组）。`max_chars` 仍作用在这一帧的 YAML 上。

YAML：`iframe` / `frame` 仍是结构角色（父树不下行），但 **走 `assignRef`**，行上出现 `[ref=@eN]`。`isolated` 为真时在固定属性顺序里加 `[isolated]`（与 `disabled` 一样：仅真才输出）。建议顺序：name、level、checked、selected、expanded、disabled、invalid、isolated、src、ref、value。

**入口判定：**

1. `selector` 能解析成节点且角色是 `iframe` 或 `frame` → 进该节点对应的子帧。若该帧 `isolated` → 跨域错误，不拍空壳。若同时传了 `frame` 且对不上这个子帧 → `iframe: selector and frame do not refer to the same frame`。
2. 否则若 `frame` 非空 → 按 frameId 精确匹配，否则按 URL 子串（对 **未截断** 的 frame URL）。0 个命中 → `iframe: no frame matching "<value>"`。≥2 个 → `iframe: multiple frames match "<value>": <url1>, <url2>, …`（最多列 5 个）。命中帧 isolated → 跨域错误。
3. 否则整页 snapshot（0.4 行为 + iframe `@e` / `[isolated]`），子孙仍剪掉。

`selector` 指向非 iframe：仍是 0.4 的子树 snapshot，发生在 **当前帧**（有 `frame=` 则在那一帧里找节点）。

### 其它工具上的 `frame`

`evaluate` / `click` / `fill` / `mouse_click` / `hover` / `screenshot` / `wait` 增加可选 `frame`（同 snapshot：frameId 或 URL 子串，多命中同样报错）。

- `@e`：忽略 `frame`，用 ref 表里的 `frameId`。
- CSS / evaluate 的 `code`：无 `frame` 则顶层；有则进该帧（同域才执行，跨域走跨域错误）。
- `screenshot.fullPage` 与 `selector` 仍互斥。`fullPage` + `frame`（tab 会话）：clip 到该 iframe 元素在 **父页视口里的可见盒**，**不是** 子文档的完整滚动高度。做不到子文档整页长截。不和 `selector` 一起用。
- `wait` 的 `url` 仍看 tab URL，不看 frame URL。`wait` 的 `text` / `selector` 在指定帧（或 `@e` 所在帧）里轮询。

### list_frames（新工具）

无参数。返回：

```json
{
  "success": true,
  "frames": [
    {
      "frameId": "…",
      "parentId": "",
      "url": "https://…",
      "name": "payment",
      "isolated": false
    }
  ]
}
```

- 含顶层帧。顶层 `parentId` 为 `""`。
- `name` 来自 iframe 的 `name`/`id` 属性，没有则 `""`。
- `isolated: true` 当且仅当该帧 **不能** 在本期 tab 会话里当同域 LocalFrame 操作（跨域 OOPIF、不透明 origin、sandbox 无 `allow-same-origin`、fenced frame 等）。
- **禁止** 出现 `targetId`、session id。
- **发现源不能只用** `Page.getFrameTree`：Blink 的 getFrameTree 只含 LocalFrame，OOPIF 根本不在树里。必须合并：
  1. `Page.getFrameTree`（同域 / in-process）
  2. 顶层 AX/DOM 里的 iframe 行（url/name）
  3. `chrome.debugger.getTargets()` 或 CDP `Target.getTargets` 里 `type=iframe` 的 url
  对得上 LocalFrame 的用其 `frameId`；只在 2/3 出现的标 `isolated: true`。没有 Chrome frameId 的 isolated 帧：`frameId` 用稳定占位（例如 `isolated:<url>`），对它 snapshot/click 仍走跨域错误。**不要**编造 CDP frameId。
- `list_frames` 自 0.6.0 引入，进 `toolSince`。缺工具错误与 0.4 同句式：
  `extension <ver> does not implement "list_frames" (need ≥ 0.6.0). Update the CSI extension from the Chrome Web Store, or reload ~/.csi/extension.`

### 混合版本（`frame` 参数）

`list_frames` 靠工具名即可改写。`frame` 是旧工具上的新参数：0.5 扩展会 **忽略未知字段**，变成误操作顶层。

daemon 在 `Inventory` 已连接时：若 `args` 含键 `frame` 且值不是 `null` / 缺省空字符串（**非字符串真值也算**，如 `true`），且扩展版本 `< 0.6.0`（缺 `tools` 的旧扩展视为不够），**不转发**，返回：

`extension <ver> does not implement "frame" (need ≥ 0.6.0). Update the CSI extension from the Chrome Web Store, or reload ~/.csi/extension.`

版本比较：hello 的 `extensionVersion` 做 semver 主.次.补；解析失败当不够。未连接仍走 `extension not connected`。闸门放在 `checkExtension` 旁边，不要改 `does not implement` 句式。

对 iframe 的 `@e` 再 snapshot **无法**在 daemon 侧识别。0.5 扩展会拍到空壳。技能：`/status.version` &lt; 0.6 或没有 `list_frames` 时不要对 iframe `@e` 再 snapshot。

## 错误文案（精确）

| 情况 | 文案 |
|---|---|
| 跨域 / 不透明源 / 非 LocalFrame | `iframe: cross-origin frame "<url>" is not supported yet. If it is a full page, navigate to its URL.` `<url>` 用该帧 URL，没有则 `unknown`。 |
| 找不到 | `iframe: no frame matching "<value>"` |
| 多命中 | `iframe: multiple frames match "<value>": <url>, <url>, …` |
| selector 与 frame 不一致 | `iframe: selector and frame do not refer to the same frame` |
| 同域但帧已没了 / context 失效 | `iframe: frame is gone; run snapshot again` |
| 非 iframe `@e` 当进框入口 | 不走 iframe 入口，当普通 selector 子树（0.4） |

业务错误仍 HTTP 200 body 的 `error`。进不去 **禁止** 返回成功空 YAML。

## ref 表

`RefEntry` 增加可选 `frameId: string`。顶层节点 `frameId` 可空或填顶层 id，解析时空 = 顶层。

iframe/frame 节点也进表（否则主路 `snapshot({selector:"@e3"})` 不成立）。

**Reset 规则：**

- **整页 snapshot**（没有非空 `frame`，且 selector 不是 iframe/frame 节点）→ `resetRefs()`，与 0.4 相同，`@e1` 起。
- **进某一帧的 snapshot** → **不 reset**，序号接着编；新节点带该 `frameId`；父页旧 `@e` 保留。
- 普通 `selector` 子树（非 iframe）→ 仍 reset。

`lookupRef` 失败文案不变。`DOM.resolveNode({ backendNodeId })` 在 **tab 会话、同进程子帧** 上可以不带 `executionContextId`（Blink 按 node 所在 LocalFrame 的 main world）。`Runtime.evaluate` / CSS `querySelector` **仍必须** 进该帧 default world 的 `contextId`（`Runtime.enable` 后看 `executionContextCreated.auxData.frameId` 且 `isDefault`；MV3 SW 可能丢事件，每个进框命令都要能刷新 context 表）。`Page.createIsolatedWorld` 仅当 default 拿不到——fill/click 看不到页面 JS，列为退路。

navigate / 关 tab / 主文档 commit 导航：清空 ref 表。iframe 内操作若只改父 DOM、没有文档 commit，父 `@e` 可能变旧：技能规定 **click 失败再重拍父页**，不要每次进出都重拍。

## 扩展实现（同域）

继续 `chrome.debugger.attach({ tabId })`，协议版本字符串保持 `"1.3"`（不是冻死在 Chrome 64 的 schema）。**不要** `Target.setAutoAttach` flatten，不要为 iframe `attach({ targetId })`。

**isolated 判定（fail closed，不要只比 URL origin）：**

1. 帧不在 `Page.getFrameTree` 的 LocalFrame 集合里 → isolated。
2. CDP `securityOriginDetails.isOpaqueOrigin` 或等价不透明源（`sandbox` 无 `allow-same-origin`、沙箱内 `about:blank` / `srcdoc`、`data:`）→ isolated。
3. 父页 `iframe.contentDocument == null`（同域才会非 null）→ isolated。
4. URL origin 与 top 不同 → isolated。
5. 比不出来 → isolated。**不要** 把「srcdoc / about:blank 且 parent 同域」一律当同域——有 sandbox 时是错的。

AX：对该 `frameId` 调 `Accessibility.getFullAXTree({ frameId })`（Chrome 86+ 字段；tab 会话对 LocalFrame 可用）。若拒绝：报 `iframe: frame is gone; run snapshot again` 或跨域文案（按 isolated），**不要** attach target。

坐标（本期 tab 会话）：`DOM.getBoxModel` / `getContentQuads` 已经是 **根视口 CSS 像素**（Blink `ConvertToRootFrame`）。`mouse_click` / `hover` / clip **不要** 再加 iframe 元素的 border box，嵌套同域也不要累加——会双重偏移点歪。以后 OOPIF 用 `targetId` 会话时再累加。手测夹具对照点击位置。

生命周期：tab detach / close 清空帧缓存和 ref。iframe 卸载后的 ref → `iframe: frame is gone; run snapshot again`。

## 技能

- Prefer snapshot：默认不传 `frame`。看见 iframe 行且 **没有** `[isolated]` → 对该 `@e` 再 snapshot，用新 `@e` 点。不要先 `list_frames`。
- `[isolated]` → 不要对它 snapshot/click；src 是完整页面再 `navigate`；否则告诉用户这期不支持跨域框。
- 进框优先 `@e`，不要用截到 80 字的 `src` 当 `frame=`。
- 嵌套：需要内层且已知完整 URL 时可用 `snapshot({frame: innerUrl})` 跳过中间层。
- 点父页：先进框不清 ref；click 失败再 snapshot 父页。
- 不要编 CDP `frameId`。
- Known limitations：跨域 iframe 0.6 只列出不进入；对话框、下载仍未做。
- operations：`does not implement "list_frames"` 或 `"frame"` → 升级扩展到 ≥ 0.6.0。

## 测试

- daemon：`list_frames` 未上报 / 旧版本 → 不转发；`frame` 非空字符串或非空真值 + 扩展 0.5.0 → 不转发，文案含 `does not implement "frame"`；未连接 → `extension not connected`。
- 扩展：进框判定、多命中、跨域文案、ref 追加 vs reset、iframe 行有 `@e` 与可选 `[isolated]`。坐标：同域 iframe 内 `getBoxModel` 与 `dispatchMouseEvent` 对齐视口，**断言不要加 offset**。typecheck/build + 手测同域夹具（父页 + same-origin iframe 按钮；第二页跨域 iframe 只断言错误 + `[isolated]`）。
- 禁止手测去点真实 Stripe/recaptcha 当成功标准。

## 版本与兼容

- 版本号留到本计划最后一次改 0.6.0（中间 commit 保持当时的 0.5.0）。
- 0.5 扩展 + 0.6 daemon：20 个老工具照常；`list_frames` 与带 `frame` 的调用走改写。
- 0.6 扩展 + 0.5 daemon：`list_frames` → `unknown tool`；带 `frame` 的 snapshot 会被 0.5 daemon 转发，0.6 扩展会进框——技能以 `/status.version` 为准。
- 不打 tag，除非用户明确说发版。
- 商店：0.6 发版后按 `store/UPLOAD.md` 再传包。

## 文件地图

- `docs/protocol.md` — §4 加 `list_frames` 为第 21；snapshot 行补 `frame`、iframe `@e` / `[isolated]`；相关工具补 `frame`；§6 写 0.6.0
- `extension/src/background/refs.ts` — `frameId?`；reset vs 追加；iframe/frame 可 `assignRef`
- `extension/src/background/debugger-session.ts` — 仍 tab attach
- `extension/src/background/tools/snapshot.ts` / `ax-yaml.ts` — 进框入口；父树剪子孙；iframe `@e` / `[isolated]`
- `extension/src/background/tools/element.ts` — 帧内 evaluate 用 contextId；resolveNode 同进程可不带 context
- `extension/src/background/tools/list-frames.ts` — getFrameTree ∪ iframe 行 ∪ getTargets
- `extension/src/background/registry.ts` — 注册；**不要**进 `SESSION_SCOPED_TOOLS`
- click/fill/evaluate/mouse_click/hover/screenshot/wait — 可选 `frame`；坐标不加 iframe offset
- `daemon/internal/tools/tools.go` — `list_frames` + `frame` 参数闸（含非字符串）
- `daemon/internal/mcp/tools.go` — schema
- `skills/csi/SKILL.md`、operations.md、README、site `tools.ts`、protocol-sync「21 个」

## 以后（不在本文件承诺排期）

跨域：对 iframe `targetId` attach、`sendCommand({ targetId })`、OOPIF 坐标（那时才累加各层 iframe 盒）。调用方仍是 `snapshot({frame})` / `@e`，不改协议形状。`isolated: true` 那时变为可进。
