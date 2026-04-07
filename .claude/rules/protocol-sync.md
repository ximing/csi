---
paths:
  - "docs/protocol.md"
  - "daemon/**/*.go"
  - "extension/src/**/*.ts"
  - "skills/**/*.md"
---
# 协议同步规则

`docs/protocol.md` 是 daemon（Go）与 extension（TS）两侧的**唯一契约**。

## 变更顺序

任何协议变更（新工具、改参数、改响应形状、改注入字段）按此顺序落地：

1. 先改 `docs/protocol.md`
2. daemon 侧：`internal/tools/tools.go` 的 `validTools`；涉及 MCP 暴露时同步 `internal/mcp/tools.go`
3. extension 侧：`src/background/tools/` 实现 + `src/background/registry.ts` 注册（tab 自管理工具同时更新 `SESSION_SCOPED_TOOLS`）；消息类型在 `src/shared/messages.ts`
4. 技能侧：`skills/csi/SKILL.md` 的工具表格

四处的工具清单必须始终一致（当前 21 个，见协议 §4）。

## 不变量

- `_` 前缀字段（`_session`/`_tabId`/`_tabIds`）只由 daemon 注入，调用方传入会被覆盖（协议 §3.4）。
- 业务错误放响应 body 的 `error` 字段，HTTP 状态码只用于传输层错误。
- 截图/PDF 由 daemon 落盘、返回文件路径，不在 WS 上传 base64 给客户端（协议 §5）。
