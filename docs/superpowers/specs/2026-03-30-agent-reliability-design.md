# Agent 可靠性设计

日期：2026-03-30
状态：待确认
版本规划：0.4.0 / 0.5.0 / 0.6.0

## 背景

CSI 0.3.0 的工具面已经够用：真实 Chrome、登录态、17 个工具、MCP、多 agent 技能。Agent 每天卡住的地方不在「少一个冷门工具」，而在下面几类往返：

| 痛点 | 现在怎么扛 | 代价 |
|---|---|---|
| 等页面就绪 | 技能教模型写 `evaluate` + bash `while` 轮询 | 一次等待 5–20 个 HTTP 往返，易写错、易超时、e2e 固化也脏 |
| snapshot 太肥 | `Accessibility.getFullAXTree` 整棵 JSON 树回传 | 大页面吃掉几千到上万 token；WS 也跟着胖 |
| 滚动 / 悬停 | `evaluate` 或点元素时顺带 `scrollIntoView` | 无限滚动、`:hover` 菜单经常失败 |
| 整页截图 | 只拍视口，或 clip 单个元素 | 长文/长表要对齐视觉时不够 |
| iframe | 文档写「请自己 navigate 进 iframe」 | 支付、编辑器、验证码、嵌入后台全是 iframe |
| 对话框 / 下载 | 没有一等公民 | `alert` 会卡住后续工具；下载只能靠用户手点 |
| 扩展/daemon 版本错位 | 协议 §6：不协商，报 `unknown tool` | 商店扩展 + Release zip 双通道之后会越来越常见 |
| 开机后 daemon 挂了 | 技能让 agent 自己 `csi start` | 能恢复，但每次冷启动都浪费一轮，用户也觉得「又坏了」 |

设置页设计（2026-03-09）已经把「开机自启」明确划出范围。本文件把它收回来，作为独立阶段，不跟协议变更绑在一起。

DirectCDP / obscura 不在本文件范围内。

## 目标

让 agent 在**普通网页**上少绕路、少烧 token、少误报「扩展坏了」；让用户**重启电脑后不用再想 daemon**。难页面（跨域 iframe、原生对话框、下载）单独成阶段，不堵第一枪。

成功标准：

1. 典型内容站（文档、后台、表单）一次 `snapshot` 的 `tree` 落在约 24k 字符以内，可交互节点仍带 `@e` ref。
2. 「等到某段文字 / 某个元素出现」是**一次** `/command`，不再是技能里的轮询教程。
3. 0.3.0 扩展连上 0.4.0 daemon 后，调用新工具得到的是「请升级扩展」而不是 `unknown tool`。
4. 安装器默认注册登录自启；`csi stop` 之后直到下次登录或下次 `start`，进程保持停止。

## 非目标

- 不改安全边界：仍只绑 `127.0.0.1`，v1 无鉴权。
- 不加 `sleep` 工具。固定睡眠继续被技能禁止。
- 不做 `networkidle`。SPA 长连接会让它永久不静，agent 会误判。
- 不跟 Chrome DevTools MCP 抢 Lighthouse / performance / console 面板。
- 0.4.0 不碰 iframe 穿透、对话框、下载（只在 compact snapshot 里**露出** iframe 节点，让模型看见它）。
- 下载需要新的 CWS 权限（`downloads`），单独评估审核成本，不塞进第一枪。
- 不做 options 页的「开机自启」开关（0.5.0 只做 CLI + 安装器；开关以后再说）。

## 怎么切：三个发版，不合成一锅

协议同步规则要求工具清单四处一致。新工具必须跟 `docs/protocol.md`、daemon `validTools`、MCP、扩展 registry、技能表同一发版落地。所以 **0.4.0 是一次协议变更**，里面的东西一起上。开机自启零协议，必须拆开。iframe / 对话框 / 下载是另一类状态机，再拆一次。

```
0.4.0  agent 不再在普通页上迷路     ← 本文件的主规格，一次协议 bump
0.5.0  重启电脑之后还在              ← 安装器 / CLI，不动协议
0.6.0  难页面                         ← 再一次协议 bump
```

0.4.0 工具数：17 → 20（加 `wait` / `scroll` / `hover`）。`snapshot` 与 `screenshot` 只加参数。

落地顺序（0.4.0 内部，仍遵守「先改 protocol.md」）：

1. 改 `docs/protocol.md`（整份 0.4.0 契约一次写完）
2. snapshot compact（无新工具，WS 立刻变瘦，单独可测）
3. hello.tools + 错误改写（后面新工具才有人能看懂失败）
4. `wait`
5. `screenshot.fullPage`
6. `scroll` / `hover`（各抄现成的 element / mouse_click）
7. daemon `validTools` + MCP schema + 技能表 + 宣传页 `tools.ts` + README「20 个工具」
8. 版本号 0.4.0（`version.go` / `manifest.json` / 技能 metadata / 插件清单 / 站点）

一步一个可跑的中间态。不要把 yaml 格式器和 `wait` 揉进同一个「大重构」PR。

---

# 阶段 A — v0.4.0 Agent 不再迷路

## A.1 snapshot：默认改成 compact YAML

### 为什么改默认

现在的 `tree` 是嵌套 JSON。模型当文本读，JSON 的键名和括号是纯税。Playwright MCP 用 YAML 无障碍快照，同一页可以少一个数量级的 token。CSI 的调用方几乎全是模型，不是解析 JSON 的程序：

- 技能只说「用 `@e` ref」
- e2e 固化**禁止**把 `@e` 写进 suite，回放走 CSS / `evaluate`
- 没有已知的外部客户端依赖 `tree` 的数组形状

所以 **0.4.0 起默认 `mode=compact`，`tree` 变成字符串**。需要旧形状时显式 `mode=full`。

### 参数

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `mode` | `compact` \| `interactive` \| `full` | `compact` | 见下 |
| `selector` | string | — | 只拍这个节点的子树（`@e` 或 CSS）。节点本身包含在输出里 |
| `max_chars` | int | `24000` | compact / interactive 的硬裁切。合法范围 1000–80000；`full` 忽略 |

### 返回

```json
{
  "url": "https://example.com/app",
  "title": "Example",
  "mode": "compact",
  "chars": 1820,
  "truncated": false,
  "tree": "- heading \"Example\" [level=1]\n- link \"More information...\" [ref=@e1]\n"
}
```

- `mode=full` 时 `tree` 仍是今天的 `SnapshotNode[]`（对象，不是字符串）。
- `chars` 是序列化后的字符数（full 用 `JSON.stringify(tree).length`）。
- `truncated=true` 时，文本末尾追加一行：
  `... truncated, <n> chars omitted. Re-snapshot with selector or mode=interactive.`
- `@e` ref 的分配规则不变：每次 snapshot `resetRefs()`，可交互节点拿到新编号。`selector` 子树也从 `@e1` 起编。

### 三种 mode

**compact（默认）** — 给模型读页 + 点选。YAML，保留结构角色和可交互 ref。

**interactive** — 只输出带 ref 的节点，扁平（不缩进子树）。大后台只想点按钮时用。

**full** — 当前 JSON 树，generic/none 仍按现逻辑折叠。逃生口，技能不主动用。

### YAML 文法（实现必须按此输出，禁止自创方言）

每一行一个节点：

```
<indent>- <role> ["<name>"] [attr=value]... [: <value>]
```

- `indent`：每层两个空格。
- `role`：AX `role.value` 原样（小写，与现在一致）。`StaticText` 输出为 `text`。
- `name`：有可访问名称时用 `JSON.stringify` 写出（始终带引号，省去转义分支）。
- 属性按固定顺序，空格分隔：
  1. `[level=N]` — heading
  2. `[checked]` / `[unchecked]` — checkbox / radio / switch（有 AX `checked` 才写）
  3. `[selected]` `[expanded]` `[disabled]` `[invalid]` — 有对应 AX 属性且为真才写
  4. `[src=URL]` — `iframe` / `img`，URL 截到 80 字符
  5. `[ref=@eN]` — 可交互且有 `backendDOMNodeId`
- `value`：textbox / combobox / searchbox / slider / spinbutton 的当前值，同样 `JSON.stringify`，跟在冒号后面。
- 单个 `name` / `value` / 文本节点超过 **120** 字符：截到 119 + `…`（一个 Unicode 省略号）。

例子：

```
- heading "Sign in" [level=1]
- textbox "Email" [ref=@e1]: "ada@example.com"
- textbox "Password" [ref=@e2]
- checkbox "Remember me" [unchecked] [ref=@e3]
- button "Continue" [ref=@e4]
- iframe "reCAPTCHA" [src=https://www.google.com/recaptcha/api2/anchor?...]
- paragraph: "By continuing you agree to the terms…"
```

### compact 收录规则

从现有 `buildTree` 的根往下走（generic/none 继续折叠），一个节点被输出当且仅当：

1. 它会拿到 ref（`INTERACTIVE_ROLES` + 有 `backendDOMNodeId`），或
2. 角色属于结构白名单：

   `heading paragraph list listitem navigation main banner contentinfo complementary form article region img table row rowheader columnheader cell caption blockquote separator status alert dialog iframe text`

3. 否则丢掉自己，子节点提升（与今天 generic 折叠相同）。

然后剪枝：输出后既没有 name/value/ref、也没有被收录的子节点 → 整节点删除。

`text`（StaticText）若其文本已经完整出现在最近祖先的 `name` 里，则不再单独输出。

`iframe` 只输出这一层，**不下行**。0.6.0 再穿透。模型至少能看见「这里有个 iframe」。

`interactive` 模式：只保留规则 1，全部顶格输出。

### 实现位置

- 格式化是纯函数，放 `extension/src/background/tools/ax-yaml.ts`，与 `snapshot.ts` 分开。`snapshot.ts` 负责 attach、拉 AX、resetRefs、裁切。
- **必须在扩展里压成 YAML 再过 WS**。如果先把 JSON 树传给 daemon 再压，WS 体积完全没省下来。
- AX 的 `level` / `checked` / `disabled` / `expanded` / `selected` / `invalid` 从节点 `properties` 里读。今天的 `SnapshotNode` 没这些字段；compact 路径直接读 AX，不要先丢再补。
- `selector` 子树：`resolveObjectId` → `DOM.describeNode` 拿 `backendNodeId` → 在 AX 列表里找对应节点当根。找不到就报 `snapshot: element not found: ...`（与 click 同一前缀风格）。

### 技能怎么写

- 默认 snapshot，不要传 `mode`。
- 页面明显被截断（末尾有 `truncated`）→ 先 `mode=interactive`；还是找不到再对容器 `selector`。
- 读文章正文：compact 即可，不要 `full`。
- `full` 留给「yaml 里角色不对、怀疑无障碍树本身」的调试。

## A.2 wait：一次调用，扩展内轮询

### 参数

恰好指定 `text` / `selector` / `url` **之一**，否则错误：

`wait: specify exactly one of text, selector, url`

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `text` | string | — | `document.body.innerText` 或任一 AX name 包含该子串 |
| `selector` | string | — | CSS 或 `@e`。元素存在、有非零布局盒、且未被 `aria-hidden` |
| `url` | string | — | 当前 tab URL `includes` 该子串（区分大小写） |
| `gone` | bool | `false` | 反转谓词：等到**不再**满足 |
| `timeout_ms` | int | `15000` | 100–120000。实际上限是 daemon 的 `tool_timeout_seconds`（谁先到谁算超时） |
| `interval_ms` | int | `200` | 50–2000，两次检查之间的间隔 |

禁止：`timeout_ms` 当 sleep 用（不传 text/selector/url）。技能写明。

`@e` 作 selector：ref 表里没有则**立刻失败**，不轮询。

`wait: unknown ref "@e9". Run snapshot first, or wait on a CSS selector / text instead.`

技能要求：wait 优先用 `text` 或 CSS；`@e` 只在「刚 snapshot 完、等这个按钮变成可见」时用。

### 返回 / 超时

成功：

```json
{ "success": true, "waitedMs": 842, "matched": "text:保存成功" }
```

`matched` 取值：`text:<原串>` / `selector:<原串>` / `url:<原串>`，`gone=true` 时前缀 `gone:`，例如 `gone:selector:.spinner`。

超时（仍是 HTTP 200 + `success:false`）：

`wait: timed out after 15000ms waiting for text "保存成功" (last url: https://example.com/save)`

`last url` 必须带上，否则模型不知道自己还在不在那一页。

### 实现

- 新文件 `extension/src/background/tools/wait.ts`。在扩展里 `while (Date.now() < deadline) { if (ok) return; await sleep(interval) }`。
- **不要**让 daemon 或技能侧轮询。一次 `tool_call` 占住这条 WS 请求直到结束。
- `text` 谓词：先 `document.body.innerText.includes`（`innerText` 不含 `display:none`）；false 再扫一份 AX name。不要每次都拉全树。
- `selector`：CSS 走 `document.querySelector` + `getBoundingClientRect`；`@e` 走 `resolveObjectId` + 同一套盒模型检查。
- `url`：`chrome.tabs.get` 当前 tab，不要 `location.href`（SPA 的 pushState 两者通常一致，但 tab.url 不依赖 JS 环境）。
- MV3 service worker：等待期间 WS 未完成、debugger 仍 attach，SW 不会被挂起。不要用 `chrome.alarms` 做 200ms 轮询（最小 30s）。
- 不注入新的 `_` 字段。daemon 超时文案保持 `tool call timeout (120s)`；技能写一句「`timeout_ms` 必须小于工具超时」。

### 技能 / e2e

- `skills/csi/SKILL.md` 删掉「用 evaluate 轮询」作为首选；改成 `wait`。
- `skills/csi-e2e/references/workflow.md` 的 bash `while` 示例换成 `wait`。
- e2e `pollUntil` 可以留着给 suite 回放（回放不经模型），但 live verify 走 `wait`。
- 明确禁止：`wait` 完不检查返回就当成功；超时要读 `error` 再 snapshot。

## A.3 screenshot.fullPage

`screenshot` 增加可选布尔 `fullPage`，默认 `false`。

- `fullPage` 与 `selector` 互斥：`screenshot: fullPage and selector are mutually exclusive`
- 实现：`Page.captureScreenshot({ format, quality?, captureBeyondViewport: true })`
- 落盘规则不变（协议 §5）
- 超高页面 CDP 可能失败：把原始错误包成 `screenshot: fullPage failed (...); try selector or a smaller viewport`
- 不加新的体积上限（PDF 的 100MB 限制不套过来）

## A.4 scroll

恰好指定 `selector` / `to` / `direction` 之一。

| 字段 | 类型 | 含义 |
|---|---|---|
| `selector` | string | `scrollIntoView({ block: 'center', inline: 'center' })`，复用现有 helper |
| `to` | `top` \| `bottom` | `window.scrollTo` |
| `direction` | `up` \| `down` \| `left` \| `right` | `window.scrollBy` |
| `amount` | number 或 `"page"` | 仅 `direction` 有效。数字 = CSS 像素；`page` = `0.9 * innerHeight/innerWidth`。默认 `"page"` |

返回：

```json
{ "success": true, "x": 0, "y": 720, "maxX": 0, "maxY": 4800 }
```

`maxX/maxY` 为 `scrollWidth - clientWidth` / `scrollHeight - clientHeight`（不小于 0），方便模型判断「还能不能再滚」。

实现：`extension/src/background/tools/scroll.ts`。`to` / `direction` 用 `Runtime.evaluate` 碰 `window`，不要引入新 CDP 域。

## A.5 hover

与 `mouse_click` 同形：`selector` 必填。

流程：`resolveObjectId` → `scrollIntoView` → 盒子中心 → `Input.dispatchMouseEvent({ type: 'mouseMoved', x, y })`。CDP 没有 `mouseEntered`，只发 `mouseMoved`。

返回与 `mouse_click` 对齐：`{ success, x, y, tag, text }`。

用途：纯 CSS `:hover` 菜单、画出隐藏按钮。不模拟 `mouseover` DOM 事件（那是 `isTrusted=false`，该用 CDP 的站点用 CDP）。

## A.6 版本握手

现在 `hello` 只带 `extensionVersion`，对不上工具时两边各说各的 `unknown tool`。

### hello / hello_ack

```json
// ext → daemon
{ "type": "hello", "payload": { "extensionVersion": "0.4.0", "tools": ["navigate", "wait", "..."] } }

// daemon → ext
{ "type": "hello_ack", "payload": { "daemonVersion": "0.4.0", "tools": ["navigate", "wait", "..."] } }
```

- `tools` 是扩展 `registry` 的全部键，握手时发一次。
- 旧扩展不发 `tools`：daemon 视为 **0.3.0 的 17 件套**（即今天协议 §4 那张表）。
- 旧 daemon 忽略多余字段，行为不变。
- 扩展忽略 `hello_ack.tools`（给日志 / 以后用，0.4.0 不做扩展侧协商）。

### 调用期改写

`tools.Executor.Execute` 在 `Valid(action)` 通过之后、转发后端之前：

1. 若 hub 记下了扩展 `tools` 且不含 `action` → 不转发，直接：

   `extension 0.3.0 does not implement "wait" (need ≥ 0.4.0). Update the CSI extension from the Chrome Web Store, or reload ~/.csi/extension.`

2. 若扩展没上报 `tools` → 用内置表：`wait` / `scroll` / `hover` 视为 0.4.0 才有，走同一句错误（版本号取 `extensionVersion`，缺省写成 `unknown`）。
3. daemon 自己就不认识的名字：继续 `unknown tool: xxx`（调用方该升级 daemon）。

这句英文是技能的稳定匹配串：`does not implement`。不要本地化。

新工具的「引入版本」写死在 daemon 一张小表里，加工具时加一行：

```go
var toolSince = map[string]string{
    "wait":   "0.4.0",
    "scroll": "0.4.0",
    "hover":  "0.4.0",
}
```

### /status

增加 `extension_tools`：`string[]`，未上报则为 `null`。`extension_version` 已有。不加 `compatible` 布尔——状态保持可解释的原始数据。

Hub 需要能读到 `ExtensionTools() []string`。handshake 的 payload 结构体加上 `Tools []string`。

## A.7 协议 §4 变更一览（0.4.0 一次写进 protocol.md）

工具表改为 20 行。相对 0.3.0：

| 工具 | 变化 |
|---|---|
| `snapshot` | 新 args：`mode` `selector` `max_chars`；返回增加 `mode` `chars` `truncated`；默认 `tree` 为 YAML 字符串 |
| `screenshot` | 新 arg：`fullPage` |
| `wait` | 新增 |
| `scroll` | 新增 |
| `hover` | 新增 |
| hello | 可选 `tools` |
| hello_ack | 增加 `tools` |
| /status | 增加 `extension_tools` |

§6 补三句：工具集仍不做自动降级；扩展缺工具时由 daemon 按 A.6 改写错误；snapshot 默认形状从 0.4.0 起改变，旧客户端传 `mode=full`。

## A.8 测试

daemon（Go，与现有同包测试）：

- `validTools` 含 `wait` `scroll` `hover`，仍拒不认识的名字
- handshake 解析 `tools`；缺省字段时 `ExtensionTools()` 为空
- `Execute("wait")` + 扩展未上报 / 上报不含 wait → 错误包含 `does not implement` 且**不**调用 backend
- 扩展上报含 wait → 转发给 backend
- `/status` 在两种握手下分别给出数组 / `null`

扩展：

- 没有单测跑器，不新造。把 yaml 格式器做成纯函数，关键用例（heading level、text 去重、120 字截断、iframe 不下行、max_chars 截断附言）用一小段可在注释或日后补跑的固定输入输出钉在 `ax-yaml.ts` 文件头。
- `npm run build` 必须过。
- 手测清单（实现者用 CSI 自己打）：example.com compact；超长页 truncated；`wait` 文字出现；`wait` 超时带 url；0.3.0 思路——临时从 hello 去掉 `wait`——错误文案；`fullPage` 与 `selector` 互斥；`hover` 打开纯 CSS 菜单。

技能：四处清单 20 个工具，与 protocol §4 逐字对齐。

---

# 阶段 B — v0.5.0 开机还在

零协议。设置页设计当时不做的那件事。

## 决策

登录时调 `csi start`（幂等）。**不用** launchd/systemd `KeepAlive` 去托管 `serve`。

原因：`csi stop` 的语义是「停到我再次 start」。KeepAlive 会把 stop 立刻拉起来，和现有 CLI、技能里的「不要擅自 stop」全部打架。

结果：

- 重启 / 重新登录 → daemon 回来
- `csi stop` → 保持停止，直到下次登录或下次 `start`
- `csi start` 在已有进程时仍然 no-op
- 崩溃不会自动拉起。接受。要自动拉起是另一回事，不混进「开机自启」

## CLI

```
csi autostart          # 同 status
csi autostart status
csi autostart on       # 幂等，覆盖写单元文件 / Run 键
csi autostart off      # 只撤自启，不停正在跑的 daemon
```

`status` 打印 `on` 或 `off`，以及单元路径。非 0 退出码只用于真正的系统错误，off 不是错误。

## 各平台

**macOS** — `~/Library/LaunchAgents/ai.csi.daemon.plist`

```xml
Label = ai.csi.daemon
ProgramArguments = [<绝对路径 ~/.csi/bin/csi>, start]
RunAtLoad = true
# 无 KeepAlive
```

`on`：写 plist，`launchctl bootout` 旧的（忽略失败）再 `bootstrap`。`off`：bootout + 删文件。

**Linux** — `~/.config/systemd/user/csi.service`

```
[Service]
Type=oneshot
ExecStart=%h/.csi/bin/csi start
[Install]
WantedBy=default.target
```

`on`：写 unit，`systemctl --user daemon-reload && enable --now`。`off`：`disable` + 删 unit + daemon-reload。不碰 lingering（没登录就不该跑）。

**Windows** — `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，值名 `CSI`，数据为 `"<csi.exe 绝对路径>" start`。不需要管理员。`off` 删这个值。

绝对路径取 `os.Executable()`，安装器拷完二进制再调 `csi autostart on`，避免指向旧位置。

## 安装器

双端同一组旗标（scripts 规则）：

- `--no-autostart` / `-NoAutostart`
- 环境变量 `CSI_NO_AUTOSTART=1`

默认：**开**。装完二进制、在 `csi start` 之前（或之后，顺序不重要，start 幂等）跑 `csi autostart on`。失败只警告，不让整个安装失败。

升级（用户再跑一次安装器）：同样 `on`，覆盖旧 plist。用户若手动 `off` 过，再跑安装器会被重新打开——写进安装器帮助和技能 operations。若以后要「尊重用户关过」，再加 `~/.csi/autostart.disabled` 哨兵；0.5.0 不做。

## 技能

`operations.md` / `SKILL.md` 里「reboot 后 daemon 挂着是预期，自己 start」改成：

1. 先 `csi start`（仍然幂等，agent 继续自己救）
2. 若用户抱怨每次开机都要等一轮，告诉他们 `csi autostart status`，必要时 `csi autostart on`

不要让 agent 自己执行 `autostart on/off`。和 stop/restart 同一档：改机器登录行为，必须用户点头。

## 测试

- Go：路径选择、plist/unit 内容的字符串断言（可把生成函数抽纯）。Windows 注册表用构建标签，CI 在 linux 上只编译。
- 安装器：帮助文本两端都出现 `--no-autostart` / `-NoAutostart`。
- 手测：三平台各一次 on → 注销/登录 → `/status` 通；off → 再登录 → 不通；`stop` 后进程不再被拉起。

---

# 阶段 C — v0.6.0 难页面

第二次协议 bump。0.4.0 只让模型**看见** iframe；这里才让它进去。

## C.1 iframe

原则：**`@e` ref 自己带着 frameId**。snapshot → click 这条主路对模型透明。

`RefEntry` 增加可选 `frameId`。`resolveObjectId` 对 `@e` 用该 frame 的执行上下文，不再默认顶层 `document.querySelector`。

新工具 `list_frames`：

```json
{ "frames": [{ "frameId": "…", "parentId": "", "url": "https://…", "name": "payment", "isolated": true }] }
```

`isolated=true` 表示跨域（CDP 仍可进，因为 debugger attach 在 tab 上）。

`snapshot` / `evaluate` / `click` / `fill` / `mouse_click` / `hover` / `screenshot` / `wait` 增加可选 `frame`：CDP `frameId` 或 URL 子串。CSS 选择器默认顶层；`@e` 忽略传入的 `frame`，以 ref 表为准。

`snapshot` 增加 `mode` 不变，另增 `descend_frames`（bool，默认 false）。true 时每个 iframe 下多一块：

```
- iframe "payment" [src=https://pay.example.com/…]
  - textbox "Card number" [ref=@e12]
```

编号全局递增，不按 frame 重置。

0.4.0 的 compact 已经输出一行 `iframe` 且不下行，和这个兼容。

## C.2 对话框

`debugger-session` 在 attach 时 `Page.enable`，听 `Page.javascriptDialogOpening`，记下 `{ type, message, defaultPrompt }`。

新工具 `handle_dialog`：

| 字段 | 类型 | 含义 |
|---|---|---|
| `action` | `accept` \| `dismiss` | 必填 |
| `prompt_text` | string | 仅 `prompt` |

无挂起对话框：`handle_dialog: no pending dialog`。

**不**自动 accept。删除确认被自动点掉比多一次工具调用更糟。

`wait` 不套对话框。若 click 引出 alert，下一次工具可能卡住直到 `tool_timeout`——技能写明：怀疑对话框时先 `handle_dialog`，或看 daemon 日志里的 `javascriptDialogOpening`。0.6.0 可在 `/status` 加 `pending_dialog`（可选，实现时再定，不提前加字段）。

## C.3 下载

单独评估。候选：

- 扩展申请 `downloads`，用 `chrome.downloads` 接到 `~/.csi/downloads/`
- 或 `Browser.setDownloadBehavior`（扩展 debugger 里这条经常被拒）

无论哪条都要改 CWS 权限说明，走一轮商店审核。0.4 / 0.5 不做。技能继续把「另存为」列为已知限制，必要时让用户手点。

---

# 兼容与发版

- 0.4.0 是一次用户可见的 snapshot 默认形状变化。Release notes 头一句写：`snapshot` 默认改 YAML，旧脚本加 `"mode":"full"`。
- 0.3.0 扩展 + 0.4.0 daemon：17 个老工具照常；`wait`/`scroll`/`hover` 走 A.6 那句人话。商店审核滞后时这是主路径，错误文案必须一次到位。
- 0.4.0 扩展 + 0.3.0 daemon：daemon 拒新工具为 `unknown tool`。技能：`unknown tool` 且 `/status.version` < 0.4.0 → 让用户升级 daemon。
- 技能 metadata、插件清单、站点 footer、`site/src/data/tools.ts` 跟版本走，不能再出现 0.3.0 发版前那种「二进制 0.3.0、技能 0.2.0」。
- 商店扩展：0.4.0 打 tag 后按 `store/UPLOAD.md` 再传一包。在商店过审前，sideload 用户靠 Release zip。

# 文件地图（0.4.0）

协议与文档：

- `docs/protocol.md` — §3.3 hello、§2.2 /status、§4 工具表、§6
- `skills/csi/SKILL.md` — 表 20 行；wait / snapshot 用法；删轮询首选
- `skills/csi-e2e/references/workflow.md` — live verify 改 wait
- `skills/csi/references/operations.md` — `does not implement` 分支
- `.claude/rules/protocol-sync.md` — 「17」改「20」
- `README.md` / `README.zh-CN.md` / `site/src/data/tools.ts` / `site/src/i18n/*`

daemon：

- `internal/ws/hub.go` — 解析并保存 `tools`
- `internal/tools/tools.go` — validTools + toolSince + 改写
- `internal/mcp/tools.go` — 三个新工具 + snapshot/screenshot 参数
- `internal/server/server.go` — `/status.extension_tools`
- 对应 `*_test.go`

扩展：

- `src/shared/messages.ts` — `HelloPayload.tools`
- `src/background/ws-client.ts` — hello 带 registry 键
- `src/background/tools/ax-yaml.ts` — 新建
- `src/background/tools/snapshot.ts` — mode / selector / max_chars
- `src/background/tools/wait.ts` `scroll.ts` `hover.ts` — 新建
- `src/background/tools/screenshot.ts` — `fullPage`
- `src/background/registry.ts` — 注册三个工具
- `src/background/refs.ts` — 不必改（frameId 留 0.6.0）

# 刻意不做的替代方案

- **wait 拆成 wait_for_text / wait_for_selector / wait_for_url**：MCP 工具定义本身就贵（Chrome DevTools MCP 的 29 个工具是反面教材）。一个工具 + 恰好一个条件，够用。
- **snapshot 默认保持 JSON，靠技能传 mode=compact**：模型不读完技能就会打光默认路径。默认必须是便宜的那个。
- **在 daemon 里把 JSON 压成 YAML**：WS 已经付过肥的钱。
- **autostart 用 KeepAlive 托管 serve**：见阶段 B。
- **0.4.0 顺便做 iframe**：ref 带 frameId 会碰到 `Runtime.evaluate` 的 contextId、AX `frameId`、跨域、编号空间，单独测一轮。compact 先露出 iframe 行，已经够 0.4 用。
