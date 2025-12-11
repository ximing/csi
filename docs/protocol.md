# cdp-bridge 协议契约（草稿）

daemon（Go）与 Chrome 扩展（TS）之间的约定。先写个大概，实现过程中再补细节；两边实现都往这份文件对齐。

## 1. 组件与拓扑

```
AI 客户端 ──HTTP──▶ daemon (127.0.0.1:10088) ◀──WS(/ws)── Chrome 扩展
```

- daemon 既是 HTTP server 也是 WebSocket server；扩展作为 WS 客户端主动连 daemon。
- 只绑定 127.0.0.1，v1 不做鉴权。
- 默认端口 10088，环境变量 `CDP_BRIDGE_PORT` 可覆盖。

## 2. HTTP API（daemon 对 AI 客户端）

### POST /command

请求体：

```json
{ "action": "navigate", "args": { "url": "https://example.com" }, "session": "my-task" }
```

响应统一 200，错误放 body：

```json
{ "success": true, "data": { ... } }
{ "success": false, "error": "..." }
```

### GET /status

daemon 状态：版本、扩展是否连接、运行时长、会话列表。

### GET /healthz

探活，返回 `ok`。

## 3. WebSocket（扩展 ↔ daemon）

- 扩展连 `ws://127.0.0.1:10088/ws`，同一时间只保留一个连接，新连接踢掉旧的。
- 消息是 JSON：`{type, requestId?, payload?}`。
- type：`hello` / `hello_ack`（握手换版本）、`ping` / `pong`（应用层保活）、`tool_call` / `tool_result`（干活）。
- daemon 收到 /command 后转成 `tool_call` 发给扩展，带 requestId，等 `tool_result` 回来再响应 HTTP。
- 扩展断线自动重连。

## 4. session

每个命令带 session 名；同一 session 打开的 tab 归到一起（之后用 Chrome tab group 展示成 `agent:<session>`）。daemon 记住每个 session 的「当前 tab」，往 tool_call 里注入 `_tabId`。

## 5. 工具清单（边做边补）

第一批先做：navigate、list_tabs、close_tab、find_tab、evaluate、screenshot、save_as_pdf、snapshot、click、fill、send_keys、network……

（细节后面补齐：参数、返回结构、错误码。）
