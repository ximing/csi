// Package backend 定义工具执行后端抽象（协议 §1：daemon 通过后端执行工具）。
package backend

import "context"

// Backend 工具执行后端。
type Backend interface {
	Name() string
	Connected() bool
	CallTool(ctx context.Context, name string, args map[string]any) (any, error)
}
