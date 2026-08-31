// Package tools 实现工具路由与结果后处理（协议 §4、§5）。
package tools

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"csi/daemon/internal/backend"
	"csi/daemon/internal/session"
	"csi/daemon/internal/ws"
)

// 协议 §4 的 21 个工具名。
var validTools = map[string]bool{
	"navigate":      true,
	"find_tab":      true,
	"snapshot":      true,
	"click":         true,
	"fill":          true,
	"evaluate":      true,
	"network":       true,
	"mouse_click":   true,
	"wait":          true,
	"scroll":        true,
	"hover":         true,
	"key_type":      true,
	"send_keys":     true,
	"cdp":           true,
	"screenshot":    true,
	"save_as_pdf":   true,
	"upload":        true,
	"list_tabs":     true,
	"close_tab":     true,
	"close_session": true,
	"list_frames":   true,
}

// toolSince 记录各工具/参数引入版本：旧扩展未上报 tools 时按此表视为缺失；
// "frame" 不是工具，是 0.6.0 起八个旧工具上的新参数闸（协议 §3.3、§4.1）。
var toolSince = map[string]string{
	"wait":        "0.4.0",
	"scroll":      "0.4.0",
	"hover":       "0.4.0",
	"list_frames": "0.6.0",
	"frame":       "0.6.0",
}

// Inventory 扩展握手上报的版本与工具清单。
type Inventory interface {
	ExtensionVersion() string
	ExtensionTools() []string
	Connected() bool
}

// Valid 校验工具名是否在协议清单内。
func Valid(name string) bool { return validTools[name] }

// Names 返回 validTools 的键，字典序（协议 §3.3 hello_ack.tools）。
func Names() []string {
	out := make([]string, 0, len(validTools))
	for n := range validTools {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// Executor 工具路由：校验 → 扩展清单检查 → session 注入 → 后端调用 → 后处理 → session 更新。
type Executor struct {
	Backend   backend.Backend
	Sessions  *session.Manager
	Inventory Inventory // 可 nil，测试可注入
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
	if err := e.checkExtension(action, args); err != nil {
		return nil, err
	}

	release, err := e.Sessions.Acquire(ctx, sess)
	if err != nil {
		return nil, err
	}
	defer release()

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	// 1. 注入 session 内部字段（协议 §3.4）
	args = e.Sessions.Inject(sess, args)

	// 2. 调用后端执行
	data, err := e.Backend.CallTool(ctx, action, args)
	if err != nil {
		var te *ws.ToolError
		if errors.As(err, &te) && te.Code == "stale_target" {
			tabId := detailTabID(te)
			next := e.Sessions.ForgetTab(sess, tabId)
			if te.Details == nil {
				te.Details = map[string]any{}
			}
			te.Details["session"] = sess
			if next != 0 {
				te.Details["nextTabId"] = next
			}
			return nil, te
		}
		return nil, err
	}

	// 3. 按返回更新 session 状态（用原始返回，含 tabId）
	e.Sessions.Update(sess, action, data)

	// 4. 大结果后处理（协议 §5：截图/PDF 落盘）。留在 session 锁内。
	return PostProcess(action, args, data)
}

func detailTabID(te *ws.ToolError) int {
	if te.Details == nil {
		return 0
	}
	switch n := te.Details["tabId"].(type) {
	case float64:
		return int(n)
	case int:
		return n
	default:
		return 0
	}
}

// checkExtension 对照扩展清单；未实现则不转发，返回升级提示（协议 §3.3）。
// 未连接时不改写，交给后端返回 extension not connected。
// frame 闸（协议 §3.3）：0.5 及更早扩展会忽略未知字段，带非空 frame 转发
// 等于误操作顶层，所以一律拦下。
func (e *Executor) checkExtension(action string, args map[string]any) error {
	if e.Inventory == nil || !e.Inventory.Connected() {
		return nil
	}
	ver := e.Inventory.ExtensionVersion()
	if ver == "" {
		ver = "unknown"
	}
	listed := e.Inventory.ExtensionTools()
	if listed != nil {
		for _, n := range listed {
			if n == action {
				return checkFrameGate(ver, true, args)
			}
		}
		return missingTool(ver, action)
	}
	if _, added := toolSince[action]; added {
		return missingTool(ver, action)
	}
	return checkFrameGate(ver, false, args)
}

// checkFrameGate：args 带非空 frame 且扩展不够新（未上报 tools 视为不够）→ 不转发。
func checkFrameGate(ver string, advertised bool, args map[string]any) error {
	v, ok := args["frame"]
	if !ok || !framePresent(v) {
		return nil
	}
	if !advertised || semverLess(ver, 0, 6, 0) {
		return missingTool(ver, "frame")
	}
	return nil
}

// framePresent：null 与空字符串视为未传；非字符串真值（如 true）算已传。
func framePresent(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case bool:
		return t
	case float64:
		return t != 0
	default:
		return true
	}
}

// semverLess 主.次.补比较；解析失败视为不够新（协议 §3.3）。
func semverLess(ver string, major, minor, patch int) bool {
	parts := strings.Split(ver, ".")
	if len(parts) != 3 {
		return true
	}
	want := [3]int{major, minor, patch}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return true
		}
		if n != want[i] {
			return n < want[i]
		}
	}
	return false
}

func missingTool(ver, action string) error {
	need, ok := toolSince[action]
	if !ok {
		need = "a newer CSI extension"
	}
	return fmt.Errorf("extension %s does not implement %q (need ≥ %s). Update the CSI extension from the Chrome Web Store, or reload ~/.csi/extension.", ver, action, need)
}
