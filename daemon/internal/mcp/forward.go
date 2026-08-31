package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// forwarder 薄代理：把 MCP 工具调用转发为 daemon 的 POST /command（协议 §2.1）。
type forwarder struct {
	baseURL string
	client  *http.Client
}

// commandRequest /command 请求体。
type commandRequest struct {
	Action  string         `json:"action"`
	Args    map[string]any `json:"args,omitempty"`
	Session string         `json:"session"`
}

// commandResponse /command 响应体（协议 §2.1：错误一律放 body）。
type commandResponse struct {
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   string          `json:"error"`
	Code    string          `json:"code"`
	Details map[string]any  `json:"details"`
}

func (f *forwarder) httpClient() *http.Client {
	if f.client != nil {
		return f.client
	}
	// 协议 §3.3：工具默认超时 120s，HTTP 侧留余量。
	return &http.Client{Timeout: 130 * time.Second}
}

// handler 生成某个工具的 MCP ToolHandler。
func (f *forwarder) handler(def toolDef) mcpsdk.ToolHandler {
	return func(ctx context.Context, req *mcpsdk.CallToolRequest) (*mcpsdk.CallToolResult, error) {
		args, err := parseArguments(req)
		if err != nil {
			return errorResult(fmt.Sprintf("invalid arguments: %v", err)), nil
		}
		if err := validateRequired(def, args); err != nil {
			return errorResult(err.Error()), nil
		}

		session, _ := args["session"].(string)
		if session == "" {
			session = "default"
		}
		delete(args, "session")

		resp, err := f.call(ctx, def.name, args, session)
		if err != nil {
			return errorResult(err.Error()), nil
		}
		if !resp.Success {
			errMsg := strings.TrimSpace(resp.Error)
			if errMsg == "" {
				errMsg = "unknown error from daemon"
			}
			if resp.Code != "" {
				errMsg += "\ncode: " + resp.Code
			}
			if len(resp.Details) > 0 {
				if b, err := json.Marshal(resp.Details); err == nil {
					errMsg += "\ndetails: " + string(b)
				}
			}
			return errorResult(errMsg), nil
		}

		text := formatData(resp.Data)
		// screenshot/save_as_pdf 返回文件路径（协议 §5）：提示用 Read 工具查看。
		if def.name == "screenshot" || def.name == "save_as_pdf" {
			if path := dataPath(resp.Data); path != "" {
				text += fmt.Sprintf("\n\nFile saved to: %s\nUse the Read tool to view this file.", path)
			}
		}
		return &mcpsdk.CallToolResult{
			Content: []mcpsdk.Content{&mcpsdk.TextContent{Text: text}},
		}, nil
	}
}

// call 调用 daemon /command。
func (f *forwarder) call(ctx context.Context, action string, args map[string]any, session string) (*commandResponse, error) {
	body, err := json.Marshal(commandRequest{Action: action, Args: args, Session: session})
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.baseURL+"/command", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := f.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("csi daemon unreachable at %s (%v) — is it running? try `csi start`", f.baseURL, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, fmt.Errorf("read daemon response: %w", err)
	}
	// HTTP 状态码仅用于传输层错误（协议 §2.1）。
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("daemon returned HTTP %d: %s", resp.StatusCode, truncate(string(data), 500))
	}
	var cr commandResponse
	if err := json.Unmarshal(data, &cr); err != nil {
		return nil, fmt.Errorf("invalid daemon response: %v: %s", err, truncate(string(data), 500))
	}
	return &cr, nil
}

// parseArguments 解析工具入参（MCP 侧 arguments 为 json.RawMessage；缺省视为 {}）。
func parseArguments(req *mcpsdk.CallToolRequest) (map[string]any, error) {
	raw := req.Params.Arguments
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	var args map[string]any
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil, err
	}
	if args == nil {
		args = map[string]any{}
	}
	return args, nil
}

// validateRequired 按协议 §4 校验必填参数存在（字符串必填参数还要求非空）。
func validateRequired(def toolDef, args map[string]any) error {
	for _, name := range def.required {
		v, ok := args[name]
		if !ok || v == nil {
			return fmt.Errorf("%s: %s is required", def.name, name)
		}
		if s, isStr := v.(string); isStr && s == "" {
			return fmt.Errorf("%s: %s is required", def.name, name)
		}
	}
	return nil
}

// formatData 将 data 序列化为 JSON 文本。
func formatData(data json.RawMessage) string {
	if len(data) == 0 {
		return `{"success":true}`
	}
	var buf bytes.Buffer
	if json.Indent(&buf, data, "", "  ") == nil {
		return buf.String()
	}
	return string(data)
}

// dataPath 从 data 中提取 path 字段。
func dataPath(data json.RawMessage) string {
	var m map[string]any
	if json.Unmarshal(data, &m) != nil {
		return ""
	}
	p, _ := m["path"].(string)
	return p
}

func errorResult(msg string) *mcpsdk.CallToolResult {
	return &mcpsdk.CallToolResult{
		IsError: true,
		Content: []mcpsdk.Content{&mcpsdk.TextContent{Text: msg}},
	}
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}
