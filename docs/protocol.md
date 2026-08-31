# CSI 协议契约 v1

本文件是 daemon（Go）与 extension（TS）两侧实现的**唯一契约**。任何一侧的实现都必须严格遵循本文件；如需变更，先改本文件再改实现。

---

## 1. 组件与拓扑

```
AI 客户端 ──HTTP──▶ daemon (127.0.0.1:10088) ◀──WS(/ws)── Chrome 扩展 (background SW)
```

- daemon 是 **HTTP server** 兼 **WebSocket server**；扩展作为 WS **客户端**主动连 daemon。
- 默认端口 `10088`；优先级：环境变量 `CSI_PORT` > `~/.csi/config.json` > 默认值。扩展默认连接 `ws://127.0.0.1:10088/ws`，popup/options 页中可改。
- daemon 持久化配置存于 `~/.csi/config.json`：`{"port":10088,"log_retention_days":3,"tool_timeout_seconds":120}`（日志保留天数与工具超时不接受 env 覆盖）。
- daemon 只绑定 `127.0.0.1`。

## 2. HTTP API

### 2.1 `POST /command`

请求体：

```json
{
  "action": "navigate",
  "args": { "url": "https://example.com", "newTab": true },
  "session": "my-task"
}
```

- `action` (string, 必填)：工具名，见 §4。
- `args` (object, 可选)：工具参数。
- `session` (string, 可选)：会话名。同一任务始终用同一 session；缺省为 `"default"`。
- 请求体整包上限 64MB（传输层，不按 action 分级）。超出则 `error` 为 `bad request body: ...`（HTTP 仍 200）。`fill.value` / `evaluate.code` / `cdp.params` 无字段级 maxLen，受此整包上限约束。

处理流程：

1. daemon 根据 session 状态向 `args` 注入内部字段（见 §3.4）：`_session`、`_tabId`、`_tabIds`。调用方传入的 `args` 中**不允许**包含 `_` 前缀字段（daemon 覆盖）。
2. 将 `{name, args}` 通过 WS 发给扩展执行。
3. 扩展返回后，daemon 做结果后处理（§5：截图/PDF 落盘），然后响应。

成功响应（HTTP 200）：

```json
{ "success": true, "data": { "success": true, "url": "https://example.com", "tabId": 123 } }
```

失败响应（HTTP 200，错误一律放 body；HTTP 状态码仅用于传输层错误）：

```json
{ "success": false, "error": "navigate: url is required" }
```

可选字段 `code` / `details`（旧客户端忽略未知字段，继续读 `error`）：

```json
{
  "success": false,
  "error": "session target tab 123 is no longer available",
  "code": "stale_target",
  "details": { "tabId": 123, "session": "my-task", "nextTabId": 122 }
}
```

`nextTabId` 仅 daemon 在清理失效 owned tab 之后填写；没有仍存活的 owned tab 时省略该字段。daemon **不**自动重放原工具。

常见错误：

| 场景 | error 内容 | code |
|---|---|---|
| 扩展未连接 | `extension not connected` | — |
| 未知工具 | `unknown tool: xxx` | — |
| 工具执行失败 | 扩展返回的原始错误消息 | 见下 |
| 执行超时 | `tool call timeout (120s)` | — |
| 注入的非零 `_tabId` 对应 tab 已不存在 | `session target tab <id> is no longer available` | `stale_target` |
| `_tabId===0` 且工具需要页面目标 | `session has no current tab; call navigate first, or find_tab(active:true) to borrow the user's tab` | `no_session_target` |
| `@e` 在当前 tab 的 ref store 中不存在 | `<tool>: unknown ref "…". Run snapshot first to get refs.` | `unknown_ref` |
| `@e` 所属 document epoch 已过期，或节点已替换 | `<tool>: stale ref "…". Page navigated; run snapshot again.` | `stale_ref` |

### 2.2 `GET /status`

```json
{
  "running": true,
  "pid": 12345,
  "version": "0.1.0",
  "extension_connected": true,
  "extension_version": "0.1.0",
  "extension_tools": ["navigate", "..."],
  "uptime_seconds": 3600,
  "sessions": ["my-task"],
  "port": 10088
}
```

`pid` 供 `csi stop` / `csi start` 做身份校验（防 PID 复用误杀）。
`extension_tools`：扩展握手上报了 `tools` 则为数组，未上报则为 `null`。

### 2.3 `GET /healthz`

返回 `200 OK`，body `ok`。仅用于存活探测。

### 2.4 `GET /config`

返回当前生效配置及每项来源（`env` / `config` / `default`）：

```json
{
  "port": { "value": 10088, "source": "default" },
  "log_retention_days": { "value": 3, "source": "config" },
  "tool_timeout_seconds": { "value": 120, "source": "default" }
}
```

### 2.5 `POST /config`

请求体为要修改的字段子集（均可选）：

```json
{ "port": 10090, "log_retention_days": 7, "tool_timeout_seconds": 60 }
```

- 校验：端口 1–65535；保留天数 1–30；超时 5–600。非法返回 `{ "success": false, "error": "..." }`。
- 端口被 `CSI_PORT` 覆盖时拒绝修改端口字段。
- `log_retention_days` / `tool_timeout_seconds` 保存后即时生效；`port` 仅落盘，响应 `data.restart_required: true`，需 `POST /restart` 生效。

成功响应：

```json
{ "success": true, "data": { "restart_required": true } }
```

**pending-restart 窗口**：端口已落盘但 daemon 尚未重启期间，CLI 按 config 读到的是新端口，而 daemon 仍监听旧端口——`csi status` 会误报未运行，`csi stop` 会因身份校验拒绝（提示用 `--force`）。用 options 页的重启按钮或 `csi restart`（身份不确认时自动转 force）可正常完成重启。

### 2.6 `POST /restart`

daemon 自重启：拉起替代 `serve` 进程后立即响应 `{ "success": true }` 并优雅退出。新进程从 config.json 读取配置监听（同端口靠 bind 退避重试接管，200ms × 最多 10s）。调用方轮询 `/healthz` 确认新进程就绪。

## 3. WebSocket 协议（`/ws`）

### 3.1 连接与重连

- 扩展连接 `ws://127.0.0.1:<port>/ws`。
- 扩展在 `chrome.storage.local` 持久化连接意愿（`ws_should_connect`、`local_url`），service worker 被挂起后通过 `chrome.alarms`（周期 0.5 分钟（可在 options 页改为 30s/60s/关闭），名 `csi-reconcile`）做 reconcile：意愿为连接且当前未连接则重连。
- daemon 侧同一时间**只接受一个扩展连接**：新连接须在 5 秒内发送 `hello` 完成握手，握手通过后才踢掉旧连接；首条消息非 `hello` 或超时直接关闭，不影响在位连接。
- `/ws` 升级校验 Origin：空 Origin（非浏览器客户端：测试、curl、未来 direct_cdp）和 `chrome-extension://*` 放行；其它 Origin 拒绝升级（HTTP 403）。扩展 id 不固定（manifest 无 `key`，未打包每机不同），只认 scheme。popup/options 不直连 `/ws`（经 service worker）。这不是鉴权，挡的是浏览器网页，不是本机任意进程。
- daemon 每 30s 发 `ping`，扩展回 `pong`（应用层，非 WS 控制帧）。daemon 对连接设读看门狗：2 倍 ping 间隔内未收到任何消息（`pong` 或其它消息均算活跃）即判定半死、主动断连，由扩展 reconcile 重连。

### 3.2 消息格式

所有消息为 JSON 文本帧，顶层结构：

```json
{ "type": "<msg_type>", "requestId": "<uuid>", "payload": { } }
```

`requestId` 仅在请求/响应类消息中必填。

### 3.3 消息类型

| 方向 | type | payload | 说明 |
|---|---|---|---|
| ext → daemon | `hello` | `{extensionVersion, tools?}` | 连接建立后扩展第一个发送 |
| daemon → ext | `hello_ack` | `{daemonVersion, tools}` | 应答 |
| daemon → ext | `ping` | — | 心跳 |
| ext → daemon | `pong` | — | 心跳应答 |
| daemon → ext | `tool_call` | `{name, args}` | 请求执行工具，带 `requestId` |
| ext → daemon | `tool_result` | `{data}` 或 `{error}` | 执行结果，`responseToRequestId` 关联 |

- `tools` 为工具名字符串数组。扩展发自己 registry 的全部键；缺省该字段（0.3.0 及更早）视为 0.3.0 的 17 件套。
- daemon 的 `hello_ack.tools` 为当前 `validTools`（排序后）。
- 扩展缺某个已调用工具时，daemon **不转发**，返回
  `extension <ver> does not implement "<name>" (need ≥ <since>). Update the CSI extension from the Chrome Web Store, or reload ~/.csi/extension.`
- 调用方对任何工具传了非空 `frame`（string；`null` / 缺省 / 空字符串视为未传，**非字符串真值也算已传**）而扩展版本 < 0.6.0（或未上报 `tools`）时，daemon 同样**不转发**，返回
  `extension <ver> does not implement "frame" (need ≥ 0.6.0). Update the CSI extension from the Chrome Web Store, or reload ~/.csi/extension.`
  版本按 hello 的 `extensionVersion` 做 semver 主.次.补比较，解析失败视为不够。
- 扩展未连接时不走此改写，与其它工具一样返回 `extension not connected`。

`tool_call` 示例：

```json
{ "type": "tool_call", "requestId": "req-abc-1", "payload": { "name": "navigate", "args": { "url": "https://example.com", "newTab": true, "_session": "my-task" } } }
```

`tool_result` 成功：

```json
{ "type": "tool_result", "responseToRequestId": "req-abc-1", "payload": { "data": { "success": true, "tabId": 123 } } }
```

`tool_result` 失败：

```json
{ "type": "tool_result", "responseToRequestId": "req-abc-1", "payload": { "error": "click: element not found: #x" } }
```

失败 payload 允许可选 `code` / `details`（与 HTTP 信封一致）。无 `code` 时只发 `{error}`。

- 工具默认超时 **120s**（可用 `POST /config` 修改 `tool_timeout_seconds`，5–600；navigate 内部页面加载超时 30s 由扩展自行处理）。
- 扩展收到未知 `type` 时忽略并打日志。

### 3.4 daemon 注入的 session 内部字段

daemon 维护 session 状态：`session → {tabIds: []int, currentTabId: int, borrowed: bool, groupTitle: string}`。

同一 session 的 `POST /command` 按接收顺序 FIFO 执行完整生命周期（注入 → 调用扩展 → 按返回更新 session）。不同 session 可以并行。

| 注入字段 | 类型 | 含义 |
|---|---|---|
| `_session` | string | 会话名（用于标签分组 `agent:<session>`） |
| `_tabId` | int | 该 session 的**当前目标**（最近一次 `navigate` / `find_tab`，**包括** `active:true` 的借用）；**无当前目标时为 `0`**（0 不是合法 Chrome tabId） |
| `_tabIds` | int[] | 该 session **拥有**的全部 tabId；**无 owned 标签时为 `[]`** |
| `_borrowed` | bool | 当前 `_tabId` 是否 **不是** owned（`_tabId ∉ _tabIds`）。无当前目标时为 `false`。始终注入。owned 判定以 `_tabIds` 为准 |

四个字段**始终注入**（缺省值 `0` / `[]` / `false`），扩展不得假设字段缺失。调用方传入的 `_` 前缀字段一律被 daemon 覆盖。HTTP / MCP 调用方**不要**传 Chrome `tabId`；目标由 session 在 daemon 侧记住。

工具返回中含有 `tabId` 时，daemon 更新当前目标。`find_tab` 返回 `borrowed:true` 时：**不**记入 `tabIds`，**但**设为当前目标（`_tabId`，`_borrowed:true`）。`borrowed` 的含义是命中 tab **不在**该 session 的 `tabIds` 中；`active:true` 命中用户正在看的 **owned** tab 时必须 `borrowed:false` 并走 owned 路径。`close_tab`/`close_session` 返回后 daemon 按下面规则更新 owned 集。

扩展侧规则：

- **owned 集只来自 `_tabIds`（过滤 `0`）。** 不得在 `_tabIds` 为空时把 `_tabId` 当作 owned。
- 单标签工具（snapshot/click/fill/...）的目标就是注入的 `_tabId`（校验该 tab 仍存在之后）。**禁止**静默回退到 last-user / 当前窗口 active tab。
- daemon 注入了非零 `_tabId` 而该 tab 已不存在：返回 `stale_target`，不得改打其它 tab。daemon 从 owned 集移除该 id（若在其中），若当前目标指向它则改到最后一个仍存活的 owned tab 或清空；**不**重放原工具。`details.nextTabId` 有则表示下一次 snapshot 可恢复到哪个 owned tab。
- `_tabId === 0`：需要页面目标的工具返回 `no_session_target`。例外：`navigate`（无 **owned** 可复用时新建 owned tab）；`find_tab(active:true)`（按用户前台选）。
- `navigate`：**只复用 owned 当前 tab**（`_tabId ∈ _tabIds` 且 tab 仍在且不是 `chrome://`/`edge://`）。当前目标为 borrowed、`newTab:true`、无 owned 可复用、或处于内部页时，一律 `tabs.create` 新 owned tab（`active:false`），**不得** `Page.navigate` / `reload` 用户 tab，不得把用户 tab 拉进 session 分组。随后当前目标切到这个新 owned tab。
- `find_tab`：默认只在 `_tabIds` 内按 URL 域名匹配；`active:true` 时选用户正在前台浏览、且 URL 匹配的标签。命中非 owned → `borrowed:true`（不拉入分组，但是当前目标）；命中 owned → `borrowed:false`。
- `close_tab`：当前目标 **不在** `_tabIds` 时返回 `{success:true, closed:false, reason:"borrowed target is not owned by this session"}`，不关 tab、不改 owned 集。`_tabId ∈ _tabIds` 时关闭该 tab（即使 `_borrowed` 误为 true）。
- `close_session`：只关闭 `_tabIds`（owned）；即使当前目标是 borrowed，也只清 session 状态，不关用户 tab。空 `_tabIds` + 非零 `_tabId` 不得关掉那个 `_tabId`。
- `list_tabs.tabs` 只列 owned。当前目标为 borrowed 时增加 `currentTarget:{tabId,borrowed:true,url,title}`，不得把 borrowed 混入 `tabs`。
- 标签分组：`navigate` **新建 owned 标签**时若带 `_session`，加入/创建标题为 `agent:<_session>`（或 `group_title` 指定值）的 tab group，颜色按 session 轮换。不得对 borrowed tab 分组。

## 4. 工具清单（21 个）

> `selector` 一律支持 `@e<num>` 引用（snapshot 产出）或 CSS 选择器。

| # | name | args | 返回 data | 备注 |
|---|---|---|---|---|
| 1 | `navigate` | `url`*, `newTab`, `group_title` | `{success, url, tabId, frameId?}` | 等待 load 完成（30s 超时）。只复用 owned 当前 tab；当前为 borrowed 时一律新建 owned tab，不改写用户 tab |
| 2 | `find_tab` | `url`*, `active` | `{success, url, tabId, borrowed}` | 见 §3.4。`borrowed:true` 当且仅当命中 tab 不在该 session 的 `tabIds` 中 |
| 3 | `snapshot` | `mode`(compact/interactive/full，默认 compact), `selector`, `max_chars`(默认 24000，1000–80000), `frame`(frameId 或未截断 URL 子串) | `{url, title, mode, chars, truncated, tree}` | compact/interactive 的 tree 是 YAML 字符串；full 的 tree 是既有 JSON 数组。iframe 只输出一行不下行，但带 `[ref=@eN]`，跨域行带 `[isolated]`；`frame` 或指向 iframe 的 `selector` 进入该帧再拍。 |
| 4 | `click` | `selector`*, `frame` | `{success, tag, text}` | DOM 级 `el.click()`。`@e` 自带 frameId，`frame` 只对 CSS/evaluate 生效 |
| 5 | `fill` | `selector`*, `value`*, `frame` | `{success, tag, mode}` | input/textarea → `mode:"value"`；contenteditable → `mode:"contenteditable"`。`@e` 自带 frameId，`frame` 只对 CSS/evaluate 生效 |
| 6 | `evaluate` | `code`*, `frame` | `{type, value}` | `Runtime.evaluate`，`awaitPromise:true`。`@e` 自带 frameId，`frame` 只对 CSS/evaluate 生效 |
| 7 | `network` | `cmd`* (start/stop/list/detail), `filter`, `requestId` | 见参考实现 | detail 返回 `{requestId,url,method,status,mimeType,base64Encoded,body}` |
| 8 | `mouse_click` | `selector`*, `frame` | `{success, x, y, tag, text}` | 坐标级 Input.dispatchMouseEvent，可过 isTrusted 检查。`@e` 自带 frameId，`frame` 只对 CSS/evaluate 生效 |
| 9 | `wait` | 恰好 `text`/`selector`/`url` 之一；`gone`；`timeout_ms`(默认 15000，100–120000)；`interval_ms`(默认 200，50–2000), `frame` | `{success, waitedMs, matched}` | 扩展内轮询。@e 不在 ref 表则立刻失败。超时文案带 last url。`@e` 自带 frameId，`frame` 只对 CSS/evaluate 生效 |
| 10 | `scroll` | 恰好 `selector` / `to`(top\|bottom) / `direction`(up\|down\|left\|right) 之一；`amount`(number\|"page"，仅 direction，默认 page) | `{success, x, y, maxX, maxY}` | page = 0.9 * innerHeight/innerWidth |
| 11 | `hover` | `selector`*, `frame` | `{success, x, y, tag, text}` | Input.dispatchMouseEvent mouseMoved，不过 mousePressed。`@e` 自带 frameId，`frame` 只对 CSS/evaluate 生效 |
| 12 | `key_type` | `text`* | `{success, length}` | `Input.insertText` |
| 13 | `send_keys` | `keys`* , `repeat`(1-100) | `{success, dispatched, os}` | 支持 `Enter`/`Escape`/`Tab`/`F1-F12`/单字母数字、修饰键 `Alt/Ctrl/Cmd/Meta/Shift/Mod`（Mod 自动解析）、空格分隔多段 |
| 14 | `cdp` | `method`*, `params` | 规范化后的 CDP 结果（见 §4.2） | 命令 params 裸透传 escape hatch；返回不是字面「原始 CDP」 |
| 15 | `screenshot` | `format`(png/jpeg), `quality`, `selector`, `fullPage`, `path`, `frame` | `{format, path, sizeBytes, mimeType}` | base64 由 daemon 落盘，见 §5；`fullPage` 与 `selector` 不能同时出现。`@e` 自带 frameId，`frame` 只对 CSS/evaluate 生效 |
| 16 | `save_as_pdf` | `paper_format`(letter/a4/legal/a3/tabloid), `landscape`, `scale`(0.1-2), `print_background`, `file_name`, `path` | `{path, sizeBytes, mimeType, pageTitle}` | daemon 落盘，100MB 上限 |
| 17 | `upload` | `selector`*, `files`* (string[]) | `{success, selector, fileCount, files}` | `DOM.setFileInputFiles`；`files` 按调用方字面传给 Chrome，不限制基目录，见 §7 |
| 18 | `list_tabs` | — | `{success, tabs:[{tabId,url,title,active,groupTitle}], currentTarget?}` | `tabs` 仅 owned；borrowed 当前目标走独立的 `currentTarget` |
| 19 | `close_tab` | — | `{success, closed, reason?}` | 关当前 **owned** 标签；borrowed 目标 `closed:false` 且不关 tab |
| 20 | `close_session` | — | `{success, closed}` | 关 session 全部标签 |
| 21 | `list_frames` | — | `{success, frames:[{frameId,parentId,url,name,isolated}]}` | 含顶层帧（`parentId` 为 `""`）。`isolated:true` 的帧本期进不去；无 CDP frameId 的 isolated 帧用 `isolated:<url>` 占位。不含 targetId |

### 4.1 iframe 与 frame 参数（0.6.0 起）

- 进框入口（snapshot 二选一）：`selector` 解析出的节点角色是 iframe/frame → 进其子帧；或 `frame` 非空 → 先按 frameId 精确匹配，再按未截断 frame URL 子串匹配。同时传且对不上 → `iframe: selector and frame do not refer to the same frame`。
- 匹配 0 个 → `iframe: no frame matching "<value>"`；≥2 个 → `iframe: multiple frames match "<value>": <url1>, <url2>, …`（最多 5 个）。
- 命中帧 isolated → `iframe: cross-origin frame "<url>" is not supported yet. If it is a full page, navigate to its URL.` 禁止返回成功空树。
- 同域帧已卸载 / context 失效 → `iframe: frame is gone; run snapshot again`。
- 进框 snapshot 返回 `{url, title, mode, chars, truncated, tree}`，`url`/`title` 用该帧的（title 没有就 `""`），`max_chars` 作用在该帧 YAML 上。只下一层。
- ref 表：按 tab 分区；`RefEntry` 加可选 `frameId`（空 = 顶层）与 `documentEpoch`。整页 snapshot 与非 iframe 的 selector 子树 → 只 reset **该 tab**（`@e1` 起）；进帧 snapshot → 不 reset，序号续编，父页旧 `@e` 保留。主文档 commit / reload / 关该 tab → 只影响该 tab。主文档 commit 提升该 tab 的 `documentEpoch`；消费 `@e` 时 epoch 不一致 → `stale_ref`。不同 tab 允许相同 `@e` 编号。任意其它 tab 关闭不得清空本 tab 的 ref。
- `frame` 在七个工具上：`@e` 忽略 `frame`（以 ref 表 frameId 为准）；CSS / evaluate 的 `code` 无 `frame` 在顶层、有 `frame` 在该帧（跨域走跨域错误）。
- `screenshot`：`fullPage` 与 `selector` 仍互斥；`fullPage + frame` clip 到该 iframe 元素在父页视口里的可见盒（不是子文档完整滚动高度）。
- `wait`：`url` 仍看 tab URL；`text`/`selector` 在指定帧（或 `@e` 所在帧）轮询。

### 4.2 `cdp` 返回形状

`cdp` 的**命令方向**是裸透传：`method` + `params` 原样交给 `chrome.debugger.sendCommand`。**返回方向**不是字面「原始 CDP」——扩展把结果收成 JSON object，再放进所有工具共用的传输信封。不要把下面三层搞混：

- HTTP `/command` 成功体：`{ "success": true, "data": <如下> }`（§2.1）。失败是 `{ "success": false, "error": "..." }`。
- WS `tool_result`：`payload` 为 `{ "data": <如下> }` 或 `{ "error": "..." }`（§3.3）。
- 上面两层是全部 21 个工具共用的传输信封。`<如下>` 才是本工具的「返回 data」。

`data` 规则（扩展 `CdpTool`；daemon `PostProcess` 对 `cdp` 原样转发，**没有二次包装**）：

| CDP 结果（`chrome.debugger.sendCommand` 的返回） | `data` |
|---|---|
| `null` / `undefined`（无返回的命令，如 `Page.bringToFront`） | `{}` |
| 非数组 object | 原样 |
| 数组或原始值（string / number / boolean） | `{ "value": <结果> }` |

绝大多数 CDP 方法走「非数组 object 原样」（例如 `Runtime.evaluate` 得到 `{result:{type,value,...}}`）。`{value}` 包装只出现在结果本身是数组或原始值时，用来保证 `data` 始终是 JSON object。

## 5. 大结果后处理（daemon 侧）

- `screenshot`：扩展返回 `{format, dataLength, data(base64)}`。daemon base64 解码后写入 `args.path`（父目录自动创建、覆盖写）；未提供 `path` 时写入 `$TMPDIR/csi-screenshot-<ts>.<ext>`。最终响应 `{format, path, sizeBytes, mimeType}`。
- `save_as_pdf`：扩展返回 `{data(base64), dataLength, pageTitle, requestedFileName}`。落盘规则同上；默认文件名取页面标题（清洗非法字符）+ `.pdf`。解码后 >100MB 拒绝并返回错误。
- `path` 按调用方字面写入：不校验 `..`、不要求绝对路径、不限制基目录。相对路径相对 **daemon 进程的 cwd**（与调用方 cwd 无关；登录自启时 cwd 通常是 `/` 或 `$HOME`，不是项目目录）。调用方应传绝对路径。未提供 `path` 才落到 `$TMPDIR`。这是产品能力（要把截图/PDF 存到项目目录），不是路径遍历漏洞，威胁模型见 §7。

## 6. 版本与兼容

- daemon 与扩展各自带版本号，`hello`/`hello_ack` 交换。
- 工具集不匹配时由 daemon 在 `/command` 返回明确错误，不做自动降级（v1 从简）。
- 0.4.0 起 snapshot 默认 `mode=compact`，`tree` 为 YAML 字符串；旧客户端传 `mode=full`。
- 扩展未实现的工具由 daemon 按 §3.3 改写错误，不发 `tool_call`。
- `wait` / `scroll` / `hover` 自 0.4.0 引入。
- `list_frames` 与工具参数 `frame` 自 0.6.0 引入；旧扩展由 daemon 按 §3.3 改写（`frame` 按参数闸）。
- 对 iframe 的 `@e` 再 snapshot 无法被 daemon 识别：0.5 扩展会拍到空壳，客户端应按 `/status.version` 与 `extension_tools` 规避。
- 0.6.0 起同域 iframe 可进入；`isolated:true`（跨域 OOPIF、不透明源、sandbox 无 allow-same-origin 等）只列不进。
- 从本版本起，stale `_tabId` 由静默回退改为 `stale_target` 错误；`_tabId===0` 的单标签工具改为 `no_session_target`。旧 HTTP 客户端仍能读 `error` 字符串，但不再得到「碰巧打到用户当前页」的成功。`find_tab(active:true)` 的借用 tab 成为 session 当前目标（不进入 owned 列表）。

## 7. 安全约束（威胁模型）

隔离边界：

- daemon 仅监听 `127.0.0.1`。
- 无认证（v1 从简）。回环隔离的是「本机 vs 网络」，不是进程沙箱，也不是「本用户 vs 本机其他用户」。
- 能对 `127.0.0.1:<port>` 发 HTTP（`POST /command`）的主体，视为与 daemon 同一信任域。
- `/ws` 对浏览器握手校验 Origin（§3.1）：空 Origin 与 `chrome-extension://*` 可连，网页 Origin 不能升级。这不是鉴权——本机非浏览器进程仍可连 `/ws`。网页即便连上也不能驱动真扩展：`tool_call` 只从 daemon 发往当前槽位（§3.3）；hello 后踢旧连接意味着网页占的是槽位本身（DoS / 伪造 `tool_result`），不是给真扩展下发 CDP。

信任域内的能力均为设计，不是漏洞：

- 驱动用户真实 Chrome（含已登录会话）。
- `evaluate` / `cdp` 是页面内任意代码执行通道——skill 文档需提示。
- `screenshot` / `save_as_pdf` 按 `args.path` 原样落盘（§5）：任何能 POST `/command` 的本地进程，都能让 daemon 以其自身权限写文件系统上的任意路径。daemon 与典型调用方同 UID；调用方自己也能写这些文件。这不是 confused deputy，也不超出「loopback 是隔离边界」的假设。v1 **不会**把 `path` 锁进 `$TMPDIR` 或某个 screenshots 基目录——那会破坏「存到项目目录」的产品需求。
- `upload` 的 `files` 按调用方字面交给 Chrome `DOM.setFileInputFiles`（§4）：当前页的 file input 会按 HTML 文件控件语义拿到这些本地文件。这是产品能力（把用户指定的本地文件——包括项目文件——塞进网页上传框），不是路径遍历，也不是网页自己发起的读盘。调用方是能 POST `/command` 的本地主体；随机网页不能打 `/command`。daemon 与典型调用方同 UID，调用方自己也能读这些文件。v1 **不会**把 `files` 锁进 `~/Downloads`——那会破坏「上传项目文件」的产品需求。`cdp` 是裸透传，能发同一条 CDP 命令。

明确不在 v1 范围内：非回环监听、加鉴权、对 `path` / `upload.files` 做沙箱。
