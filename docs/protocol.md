# cdp-bridge 协议契约 v1

本文件是 daemon（Go）与 extension（TS）两侧实现的**唯一契约**。任何一侧的实现都必须严格遵循本文件；如需变更，先改本文件再改实现。

---

## 1. 组件与拓扑

```
AI 客户端 ──HTTP──▶ daemon (127.0.0.1:10088) ◀──WS(/ws)── Chrome 扩展 (background SW)
```

- daemon 是 **HTTP server** 兼 **WebSocket server**；扩展作为 WS **客户端**主动连 daemon。
- 默认端口 `10088`，环境变量 `CDP_BRIDGE_PORT` 可覆盖。扩展默认连接 `ws://127.0.0.1:10088/ws`，popup 中可改。
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

常见错误：

| 场景 | error 内容 |
|---|---|
| 扩展未连接 | `extension not connected` |
| 未知工具 | `unknown tool: xxx` |
| 工具执行失败 | 扩展返回的原始错误消息 |
| 执行超时 | `tool call timeout (120s)` |

### 2.2 `GET /status`

```json
{
  "running": true,
  "version": "0.1.0",
  "extension_connected": true,
  "extension_version": "0.1.0",
  "uptime_seconds": 3600,
  "sessions": ["my-task"],
  "port": 10088
}
```

### 2.3 `GET /healthz`

返回 `200 OK`，body `ok`。仅用于存活探测。

## 3. WebSocket 协议（`/ws`）

### 3.1 连接与重连

- 扩展连接 `ws://127.0.0.1:<port>/ws`。
- 扩展在 `chrome.storage.local` 持久化连接意愿（`ws_should_connect`、`local_url`），service worker 被挂起后通过 `chrome.alarms`（周期 0.5 分钟，名 `webbridge-reconcile`）做 reconcile：意愿为连接且当前未连接则重连。
- daemon 侧同一时间**只接受一个扩展连接**；新连接到来时踢掉旧连接。
- daemon 每 30s 发 `ping`，扩展回 `pong`（应用层，非 WS 控制帧）。

### 3.2 消息格式

所有消息为 JSON 文本帧，顶层结构：

```json
{ "type": "<msg_type>", "requestId": "<uuid>", "payload": { } }
```

`requestId` 仅在请求/响应类消息中必填。

### 3.3 消息类型

| 方向 | type | payload | 说明 |
|---|---|---|---|
| ext → daemon | `hello` | `{extensionVersion}` | 连接建立后扩展第一个发送 |
| daemon → ext | `hello_ack` | `{daemonVersion}` | 应答 |
| daemon → ext | `ping` | — | 心跳 |
| ext → daemon | `pong` | — | 心跳应答 |
| daemon → ext | `tool_call` | `{name, args}` | 请求执行工具，带 `requestId` |
| ext → daemon | `tool_result` | `{data}` 或 `{error}` | 执行结果，`responseToRequestId` 关联 |

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

- 工具默认超时 **120s**（navigate 内部页面加载超时 30s 由扩展自行处理）。
- 扩展收到未知 `type` 时忽略并打日志。

### 3.4 daemon 注入的 session 内部字段

daemon 维护 session 状态：`session → {tabIds: []int, lastTabId: int, groupTitle: string}`。

| 注入字段 | 类型 | 含义 |
|---|---|---|
| `_session` | string | 会话名（用于标签分组 `agent:<session>`） |
| `_tabId` | int | 该 session 的"当前标签"（最近一次 navigate/find_tab 的 tabId）；**无当前标签时为 `0`**（0 不是合法 Chrome tabId，扩展按"无"处理） |
| `_tabIds` | int[] | 该 session 拥有的全部 tabId；**无标签时为 `[]`** |

三个字段**始终注入**（缺省值 `0` / `[]`），扩展不得假设字段缺失。调用方传入的 `_` 前缀字段一律被 daemon 覆盖。

工具返回中含有 `tabId` 时，daemon 更新 session 状态（记录/切换当前标签）。**例外：`find_tab(active:true)` 借用的标签（返回 `borrowed:true`）daemon 不得收编**——不记入 tabIds、不设为当前标签；借用标签只被当次/显式指定 `_tabId` 的工具就地操作，不出现在 `list_tabs`，不被 `close_tab`/`close_session` 关闭。`close_tab`/`close_session` 返回后 daemon 移除对应 tabId。

扩展侧规则（与参考实现对齐）：

- 单标签工具（snapshot/click/fill/...）作用于"当前标签"：优先 `_tabId`（**若该 id 已失效——如用户手动关闭——扩展必须静默回退**，不得报错），其次扩展内记录的最后操作标签，再次浏览器当前 active tab。
- `navigate`：无当前标签或 `newTab:true` 时新建标签（`active:false`），否则在当前标签内跳转；`chrome://`/`edge://` 页面上一律新建，**新建的标签同样执行 attach + session 分组**，与其他新建分支一致。
- `find_tab`：默认只在 `_tabIds` 内按 URL 域名匹配；`active:true` 时借用用户正在前台浏览的标签（返回 `borrowed:true`，不拉入分组）。
- 标签分组：`navigate` 新建标签时若带 `_session`，加入/创建标题为 `agent:<_session>`（或 `group_title` 指定值）的 tab group，颜色按 session 轮换。

## 4. 工具清单（17 个）

> `selector` 一律支持 `@e<num>` 引用（snapshot 产出）或 CSS 选择器。

| # | name | args | 返回 data | 备注 |
|---|---|---|---|---|
| 1 | `navigate` | `url`*, `newTab`, `group_title` | `{success, url, tabId, frameId?}` | 等待 load 完成（30s 超时） |
| 2 | `find_tab` | `url`*, `active` | `{success, url, tabId, borrowed}` | 见 §3.4 |
| 3 | `snapshot` | — | `{url, title, tree}` | Accessibility.getFullAXTree；可交互元素带 `ref:"@eN"` |
| 4 | `click` | `selector`* | `{success, tag, text}` | DOM 级 `el.click()` |
| 5 | `fill` | `selector`*, `value`* | `{success, tag, mode}` | input/textarea → `mode:"value"`；contenteditable → `mode:"contenteditable"` |
| 6 | `evaluate` | `code`* | `{type, value}` | `Runtime.evaluate`，`awaitPromise:true` |
| 7 | `network` | `cmd`* (start/stop/list/detail), `filter`, `requestId` | 见参考实现 | detail 返回 `{requestId,url,method,status,mimeType,base64Encoded,body}` |
| 8 | `mouse_click` | `selector`* | `{success, x, y, tag, text}` | 坐标级 Input.dispatchMouseEvent，可过 isTrusted 检查 |
| 9 | `key_type` | `text`* | `{success, length}` | `Input.insertText` |
| 10 | `send_keys` | `keys`* , `repeat`(1-100) | `{success, dispatched, os}` | 支持 `Enter`/`Escape`/`Tab`/`F1-F12`/单字母数字、修饰键 `Alt/Ctrl/Cmd/Meta/Shift/Mod`（Mod 自动解析）、空格分隔多段 |
| 11 | `cdp` | `method`*, `params` | 原始 CDP 返回 | 裸透传 escape hatch |
| 12 | `screenshot` | `format`(png/jpeg), `quality`, `selector`, `path` | `{format, path, sizeBytes, mimeType}` | base64 由 daemon 落盘，见 §5 |
| 13 | `save_as_pdf` | `paper_format`(letter/a4/legal/a3/tabloid), `landscape`, `scale`(0.1-2), `print_background`, `file_name`, `path` | `{path, sizeBytes, mimeType, pageTitle}` | daemon 落盘，100MB 上限 |
| 14 | `upload` | `selector`*, `files`* (string[]) | `{success, selector, fileCount, files}` | `DOM.setFileInputFiles` |
| 15 | `list_tabs` | — | `{success, tabs:[{tabId,url,title,active,groupTitle}]}` | 仅当前 session |
| 16 | `close_tab` | — | `{success, closed, reason?}` | 关当前标签 |
| 17 | `close_session` | — | `{success, closed}` | 关 session 全部标签 |

## 5. 大结果后处理（daemon 侧）

- `screenshot`：扩展返回 `{format, dataLength, data(base64)}`。daemon base64 解码后写入 `args.path`（父目录自动创建、覆盖写）；未提供 `path` 时写入 `$TMPDIR/cdp-bridge-screenshot-<ts>.<ext>`。最终响应 `{format, path, sizeBytes, mimeType}`。
- `save_as_pdf`：扩展返回 `{data(base64), dataLength, pageTitle, requestedFileName}`。落盘规则同上；默认文件名取页面标题（清洗非法字符）+ `.pdf`。解码后 >100MB 拒绝并返回错误。

## 6. 版本与兼容

- daemon 与扩展各自带版本号，`hello`/`hello_ack` 交换。
- 工具集不匹配时由 daemon 在 `/command` 返回明确错误，不做自动协商（v1 从简）。

## 7. 安全约束

- daemon 仅监听 `127.0.0.1`。
- 无认证（v1 从简）；依赖本机回环隔离。
- `evaluate`/`cdp` 是任意代码执行通道——这是设计能力，skill 文档需提示。
