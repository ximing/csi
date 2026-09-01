package ws

// ToolError 扩展 tool_result 失败（协议 §3.3）：保留 error 字符串，可选 code/details。
type ToolError struct {
	Message string
	Code    string
	Details map[string]any
}

func (e *ToolError) Error() string { return e.Message }
