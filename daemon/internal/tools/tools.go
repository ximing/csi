// Package tools 实现工具路由与结果后处理（协议 §4、§5）。
package tools

import (
	"context"
	"fmt"

	"cdp-bridge/daemon/internal/backend"
	"cdp-bridge/daemon/internal/session"
)

// 协议 §4 的 17 个工具名。
var validTools = map[string]bool{
	"navigate":      true,
	"find_tab":      true,
	"snapshot":      true,
	"click":         true,
	"fill":          true,
	"evaluate":      true,
	"network":       true,
	"mouse_click":   true,
	"key_type":      true,
	"send_keys":     true,
	"cdp":           true,
	"screenshot":    true,
	"save_as_pdf":   true,
	"upload":        true,
	"list_tabs":     true,
	"close_tab":     true,
	"close_session": true,
}

// Valid 校验工具名是否在协议清单内。
func Valid(name string) bool { return validTools[name] }

// Executor 工具路由：校验 → session 注入 → 后端调用 → 后处理 → session 更新。
type Executor struct {
	Backend  backend.Backend
	Sessions *session.Manager
}

// NewExecutor 创建 Executor。
func NewExecutor(b backend.Backend, sm *session.Manager) *Executor {
	return &Executor{Backend: b, Sessions: sm}
}

// Execute 执行一次 /command 请求，返回工具的 data 或错误。
func (e *Executor) Execute(ctx context.Context, action, sess string, args map[string]any) (any, error) {
	if !Valid(action) {
		return nil, fmt.Errorf("unknown tool: %s", action)
	}
	if sess == "" {
		sess = "default" // 协议 §2.1：缺省 session 为 "default"
	}
	if args == nil {
		args = map[string]any{}
	}

	// 1. 注入 session 内部字段（协议 §3.4）
	args = e.Sessions.Inject(sess, args)

	// 2. 调用后端执行
	data, err := e.Backend.CallTool(ctx, action, args)
	if err != nil {
		return nil, err
	}

	// 3. 按返回更新 session 状态（用原始返回，含 tabId）
	e.Sessions.Update(sess, action, data)

	// 4. 大结果后处理（协议 §5：截图/PDF 落盘）
	return PostProcess(action, args, data)
}
