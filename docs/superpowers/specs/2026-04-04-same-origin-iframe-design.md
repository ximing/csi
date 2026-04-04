# 0.6.0 同域 iframe 穿透

日期：2026-04-04
状态：待确认
版本：0.6.0（协议 bump）。本文件取代 `2026-03-30-agent-reliability-design.md` 的 **C.1**。C.2 对话框、C.3 下载仍在那份里，**不在本期**。

## 背景

0.4 compact snapshot 把 iframe 收成一行 `src`，不下行。技能退路是 `navigate` 进 iframe URL。这对「整页被嵌进去」勉强能用；对同域后台套的框，agent 看得见进不去。跨域 OOPIF（Stripe、多数 OAuth/支付窗、recaptcha）是另一套 CDP（要对 iframe `targetId` attach），实现和坐标换算都更重。

本期只打同域，把 API 做成以后补跨域也不改形状。默认 snapshot **不**自动下行——否则广告/验证码会把 24k YAML 打爆，操作次数表面上少、token 实际上差。

## 目标

1. 同域 iframe：对那一行再 `snapshot` 一次，即可 click/fill/wait，不必新开 tab。
2. 跨域 iframe：列得出、进不去，错误是稳定英文，不给空树装成功。
3. 整页 snapshot 的 token 与 0.4 同量级（仍一行 iframe）。进框多 1 次 snapshot，只含那一帧。
4. 进框后父页 `@e` 还在，不必为了点回父页再拍一次整页。

## 非目标

- 不 attach OOPIF `targetId`（留给 0.6.x / 0.7）。
- 不设 `descend_frames`，不把所有 frame 展平进一次 snapshot。
- 不做 `handle_dialog`、不做下载、不申请 `downloads` 权限。
- 不改安全边界（仍 `127.0.0.1`，v1 无鉴权）。
- 不把 `targetId` 暴露给调用方。
- 不自动 `navigate` 进 iframe src。

## 成功标准

1. 同域夹具页：父 `snapshot` 只有 iframe 行、无框内控件；对该 iframe 的 `@e` 再 snapshot，YAML 里出现框内 button/textbox 且带 `@e`；随后 `click` 那个 ref 成功。
2. 跨域 iframe：`snapshot({frame})` / 对跨域 iframe `@e` 再 snapshot / 带 `frame=` 的 click，返回下文规定的 `iframe: cross-origin…` 文案；`list_frames` 对该帧 `isolated: true`。
3. `frame=` URL 子串命中多个帧 → 失败并列候选，不默进第一个。
4. 进框 snapshot 之后，父页上一个 `@e` 仍能 click。
5. 0.5 扩展 + 0.6 daemon：调用 `list_frames`，或任一工具带非空 `frame`，走 §3.3 同构的 `does not implement`（见「混合版本」），不把 `frame` 当未知参数丢掉后误操作顶层。

## Agent 主路

默认 `snapshot` 与 0.4 相同：iframe 只留一行，子孙剪掉。

进某一框，下面两个入口等价：

- `snapshot({ selector: "@e3" })` 且 `@e3` 是 iframe（或 frame）节点
- `snapshot({ frame: "admin.internal/widget" })` — URL **子串** 匹配 `list_frames` / frame tree 的 `url`

只下一层。框里若还有 iframe，仍是一行，再 snapshot 才进。

之后 `click` / `fill` / `hover` / `mouse_click` / `wait` / `screenshot` **不必传 frame**。`@e` 自带 `frameId`。调用方再传 `frame=` 也忽略，以 ref 表为准。

CSS 选择器默认顶层。要在某帧里用 CSS，必须显式 `frame=`。

整页型嵌入（Google Docs 一类）以及 `isolated: true` 的跨域帧：技能才允许 `navigate` 进 src。

## 协议

工具数 20 → 21。先改 `docs/protocol.md`，再改 `validTools`、MCP `toolDefs`、扩展 registry、`skills/csi/SKILL.md`。

### snapshot

现有 `mode` / `selector` / `max_chars` 不变。新增：

| 字段 | 类型 | 含义 |
|---|---|---|
| `frame` | string | 可选。CDP `frameId` **或** URL 子串。与「selector 指向 iframe」二选一作为进框入口；两者同时出现见下。 |

进框时返回形状仍是 `{url, title, mode, chars, truncated, tree}`。`url` / `title` 用 **那一帧** 的（frame URL；title 没有就空字符串）。`tree` 是那一帧的 compact YAML（或 `mode=full` 的 JSON 数组）。`max_chars` 仍作用在这一帧的 YAML 上。

**入口判定：**

1. `selector` 能解析成节点且角色是 `iframe` 或 `frame` → 进该节点对应的子帧。若同时传了 `frame` 且对不上这个子帧 → `iframe: selector and frame do not refer to the same frame`。
2. 否则若 `frame` 非空 → 按 frameId 精确匹配，否则按 URL 子串。0 个命中 → `iframe: no frame matching "<value>"`。≥2 个 → `iframe: multiple frames match "<value>": <url1>, <url2>, …`（URL 用 frame tree 里的，最多列 5 个）。
3. 否则整页 snapshot（0.4 行为），iframe 子孙仍剪掉。

`selector` 指向非 iframe：仍是 0.4 的子树 snapshot，发生在 **当前帧**（有 `frame=` 则在那一帧里找节点）。

### 其它工具上的 `frame`

`evaluate` / `click` / `fill` / `mouse_click` / `hover` / `screenshot` / `wait` 增加可选 `frame`（同 snapshot：frameId 或 URL 子串，多命中同样报错）。

- `@e`：忽略 `frame`，用 ref 表里的 `frameId`。
- CSS / evaluate 的 `code`：无 `frame` 则顶层；有则进该帧（同域才执行，跨域走跨域错误）。
- `screenshot.fullPage` 与 `selector` 仍互斥；`fullPage` + `frame`：只拍那一帧的文档，不和 `selector` 一起用。
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
- `isolated: true` 当且仅当该帧与顶层 **跨域**（OOPIF / 不同 origin）。本期不能对它 snapshot/click。
- **禁止** 出现 `targetId`、session id、internal Chrome id。
- `list_frames` 自 0.6.0 引入，进 `toolSince`。缺工具错误与 0.4 同句式：
  `extension <ver> does not implement "list_frames" (need ≥ 0.6.0). Update the CSI extension from the Chrome Web Store, or reload ~/.csi/extension.`

### 混合版本（`frame` 参数）

`list_frames` 靠工具名即可改写。`frame` 是旧工具上的新参数：0.5 扩展会 **忽略未知字段**，变成误操作顶层。

daemon 在 `Inventory` 已连接时：若 `args.frame` 是非空字符串，且扩展版本 `< 0.6.0`（缺 `tools` 的旧扩展视为 0.3 清单，同样不够），**不转发**，返回：

`extension <ver> does not implement "frame" (need ≥ 0.6.0). Update the CSI extension from the Chrome Web Store, or reload ~/.csi/extension.`

版本比较：以 hello 的 `extensionVersion` 做 semver 主.次.补；解析失败当不够。未连接仍走 `extension not connected`，与 wait 相同。

对 iframe 的 `@e` 再 snapshot **无法**在 daemon 侧识别（那是扩展语义），0.5 扩展会拍到空壳节点。技能写：没 `list_frames`、版本 &lt; 0.6 时不要对 iframe `@e` 再 snapshot。不为此再发明工具名。

## 错误文案（精确）

| 情况 | 文案 |
|---|---|
| 跨域 | `iframe: cross-origin frame "<url>" is not supported yet. If it is a full page, navigate to its URL.` `<url>` 用该帧 URL，没有则 `unknown`。 |
| 找不到 | `iframe: no frame matching "<value>"` |
| 多命中 | `iframe: multiple frames match "<value>": <url>, <url>, …` |
| selector 与 frame 不一致 | `iframe: selector and frame do not refer to the same frame` |
| 同域但帧已没了 / context 失效 | `iframe: frame is gone; run snapshot again` |
| 非 iframe `@e` 当进框入口 | 不走 iframe 入口，当普通 selector 子树（0.4） |

业务错误仍 HTTP 200 body 的 `error`。

## ref 表

`RefEntry` 增加可选 `frameId: string`。顶层节点 `frameId` 可空或填顶层 id，解析时空 = 顶层。

**Reset 规则：**

- **整页 snapshot**（没有非空 `frame`，且 selector 不是 iframe/frame 节点）→ `resetRefs()`，与 0.4 相同，`@e1` 起。
- **进某一帧的 snapshot**（上述两个入口）→ **不 reset**，序号接着编；新节点写入带该 `frameId` 的 entry；父页旧 `@e` 保留。
- 普通 `selector` 子树（非 iframe）→ 仍 reset（0.4：每次 snapshot 都是新编号）。避免「拍个按钮子树却和整页编号搅在一起」。只有「进 iframe」这一种 snapshot 追加。

`lookupRef` 失败文案不变。`resolveObjectId` 对带 `frameId` 的 ref：在该帧的 execution context 里 `DOM.resolveNode({ backendNodeId })`（或等价：先切到该帧再 resolve）。backendNodeId 只在那一帧有意义。

navigate / 关 tab / 主文档 commit 导航：清空 ref 表（与今天「下次 snapshot 才有 ref」一致；导航后旧 `@e` 本就会失效）。

## 扩展实现（同域）

继续 `chrome.debugger.attach({ tabId })`。**不要** `Target.setAutoAttach` flatten，不要为 iframe `attach({ targetId })`。

发现帧：`Page.getFrameTree`（可辅 `Page.enable` 已有或补上）。origin 比较：frame URL 与 top URL 的 origin；`about:blank` 且 parent 同域当同域；`srcdoc` 同域。比不出来宁可标 `isolated: true` 走跨域错误，不要猜成同域乱 evaluate。

AX：对该 `frameId` 调 `Accessibility.getFullAXTree({ frameId })`。若 Chrome 在 tab 会话拒绝，视为实现 blocker，**不要**改成 attach target 混过去——那是跨域方案，不在本期。

`Runtime.evaluate` / `querySelector`：必须进该帧的 default world（`contextId` 来自 `Runtime.executionContextCreated` 的 `auxData.frameId`，或 `Page.createIsolatedWorld` 仅当 default 拿不到——优先 default，和页面 JS 同世界，fill/click 才看得到框架自己的变量）。

坐标：`mouse_click` / `hover` / `screenshot` clip 在 iframe 内取 box，再加上该 iframe **元素**在父文档视口里的 border box。同域也能点歪，这步必做。嵌套同域：从目标帧向外累加每层 iframe 元素偏移。

跨域：发现 `isolated` 后立刻按上表报错，不发进框的 AX/evaluate。

生命周期：tab detach / close 清空帧缓存和 ref。iframe 卸载后的 ref → `iframe: frame is gone; run snapshot again`。不在失败路径上对用户机器做额外 attach。

## 技能

- Prefer snapshot 节：默认仍不传 `frame`。看见 iframe 行且 `list_frames` 里 `isolated: false` → 对该 `@e` 再 snapshot，用新 `@e` 点。
- `isolated: true` → 不要对它 snapshot/click；若 src 是完整页面再 `navigate`；否则告诉用户这期不支持跨域框。
- 不要让模型编 CDP `frameId`；用 snapshot 给的 `@e` 或 URL 子串。
- Known limitations：跨域 iframe 0.6 只列出不进入；对话框、下载仍未做。
- operations：`does not implement "list_frames"` 或 `"frame"` → 升级扩展到 ≥ 0.6.0。

## 测试

- daemon：`list_frames` 未上报 / 旧版本 → 不转发；`frame` 非空 + 扩展 0.5.0 → 不转发，文案含 `does not implement "frame"`；未连接 → `extension not connected`。
- 扩展：进框判定、多命中、跨域文案、ref 追加 vs reset、同域偏移（可用固定 box 夹具或纯函数测累加）。无测试跑器则 typecheck/build + 手测同域夹具 HTML（父页 + same-origin iframe 按钮；第二页跨域 iframe 只断言错误）。
- 禁止手测去点真实 Stripe/recaptcha 当成功标准。

## 版本与兼容

- 版本号留到本计划最后一次改 0.6.0（与 0.4 相同：中间 commit 保持当时的 0.5.0）。
- 0.5 扩展 + 0.6 daemon：20 个老工具照常；`list_frames` 与带 `frame` 的调用走改写。
- 0.6 扩展 + 0.5 daemon：`list_frames` → daemon `unknown tool`；带 `frame` 的 snapshot 会被 0.5 daemon 原样转发，0.6 扩展会执行进框——技能以 `/status.version` 为准。
- 不打 tag，除非用户明确说发版。
- 商店：0.6 是协议+扩展变更，发版后按 `store/UPLOAD.md` 再传包。

## 文件地图

- `docs/protocol.md` — §4 加 `list_frames` 为第 21；snapshot 行补 `frame`；相关工具补 `frame`；§6 写 0.6.0
- `extension/src/background/refs.ts` — `frameId?`；reset vs 追加
- `extension/src/background/debugger-session.ts` — 仍 tab attach；可加按 frame 的 send 封装，但不切 target
- `extension/src/background/tools/snapshot.ts` / `ax-yaml.ts` — 进框入口；父树继续剪 iframe 子孙
- `extension/src/background/tools/element.ts` — resolve 走帧 context
- `extension/src/background/tools/list-frames.ts` — 新建
- `extension/src/background/registry.ts` — 注册；**不要**进 `SESSION_SCOPED_TOOLS`
- click/fill/evaluate/mouse_click/hover/screenshot/wait — 可选 `frame`
- `daemon/internal/tools/tools.go` — `list_frames` + `frame` 参数闸
- `daemon/internal/mcp/tools.go` — schema
- `skills/csi/SKILL.md`、operations.md、README、site `tools.ts`、protocol-sync「21 个」

## 以后（不在本文件承诺排期）

跨域：对 iframe `targetId` attach、`sendCommand({ targetId })`、OOPIF 坐标。调用方仍是 `snapshot({frame})` / `@e`，不改协议形状。`isolated: true` 那时变为可进。
