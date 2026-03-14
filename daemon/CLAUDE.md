# daemon 目录说明

## 这个目录负责什么

Go daemon：AI 客户端的 HTTP 入口 + 扩展的 WS 服务端 + 会话状态 + CLI 生命周期命令 + stdio MCP 代理。

## 结构

- `cmd/csi/` — CLI 入口（`start`/`stop`/`status`/`mcp` 等命令、平台相关的 `sysproc_*`/`alive_*`）
- `internal/server/` — HTTP 路由（`/command`、`/status`、`/healthz` 等）
- `internal/ws/` — WS hub，扩展连接管理（hello 门控、pong 看门狗）
- `internal/session/` — 会话状态：`_session`/`_tabId`/`_tabIds` 注入与更新（协议 §3.4）
- `internal/tools/` — 工具名校验（`validTools` 必须等于协议 §4 清单）与结果后处理（截图/PDF 落盘，协议 §5）
- `internal/backend/` — `Backend` 接口；`extension.go`（经 WS 转发给扩展）与 `direct_cdp.go`（预留的 headless 路线）
- `internal/mcp/` — stdio MCP server，薄代理：每个工具调用转发到本地 `POST /command`
- `internal/daemon/` — 进程守护、PID 文件、日志按天滚动（最多留 3 天）

## 放置约束

- 新工具的校验只动 `internal/tools/tools.go` 的 `validTools`；执行逻辑在扩展侧，daemon 不实现工具语义。
- 业务错误一律放响应 body 的 `error` 字段，HTTP 状态码只用于传输层错误（协议 §2.1）。
- 代码注释用中文，引用协议章节时写 `协议 §x.y` 格式。

## 开发偏好

- 测试：标准 `go test ./...`，测试文件与被测文件同包同目录。
- 改完构建到真实位置验证：`go build -o ~/.csi/bin/csi ./cmd/csi`。
