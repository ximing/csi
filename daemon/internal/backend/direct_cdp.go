package backend

import (
	"context"
	"errors"
)

// DirectCDPBackend 直连 CDP 后端（stub，Phase 2+ 实现）。
//
// 后期计划接入 obscura，直接对本机/无头 Chrome 的 DevTools Protocol 发命令，
// 不依赖 Chrome 扩展。当前仅保留接口占位，所有调用返回未实现错误。
type DirectCDPBackend struct{}

// Name 后端名。
func (b *DirectCDPBackend) Name() string { return "direct-cdp" }

// Connected 恒为 false（stub 尚未实现连接管理）。
func (b *DirectCDPBackend) Connected() bool { return false }

// CallTool stub：未实现。
func (b *DirectCDPBackend) CallTool(ctx context.Context, name string, args map[string]any) (any, error) {
	return nil, errors.New("direct cdp backend not implemented yet")
}
