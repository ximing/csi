package backend

import (
	"context"
	"encoding/json"

	"cdp-bridge/daemon/internal/ws"
)

// ExtensionBackend 基于 WS hub 的扩展后端（协议 §3：tool_call/tool_result）。
type ExtensionBackend struct {
	Hub *ws.Hub
}

// NewExtensionBackend 创建扩展后端。
func NewExtensionBackend(hub *ws.Hub) *ExtensionBackend {
	return &ExtensionBackend{Hub: hub}
}

// Name 后端名。
func (b *ExtensionBackend) Name() string { return "extension" }

// Connected 扩展是否已连接。
func (b *ExtensionBackend) Connected() bool { return b.Hub.Connected() }

// CallTool 通过 WS 调用扩展执行工具，返回工具 data（已 JSON 解码）。
func (b *ExtensionBackend) CallTool(ctx context.Context, name string, args map[string]any) (any, error) {
	data, err := b.Hub.CallTool(ctx, name, args)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, nil
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, err
	}
	return v, nil
}
