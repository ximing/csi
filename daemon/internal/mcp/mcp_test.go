package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

var wantTools = []string{
	"navigate", "find_tab", "snapshot", "click", "fill", "evaluate",
	"network", "mouse_click", "key_type", "send_keys", "cdp",
	"screenshot", "save_as_pdf", "upload", "list_tabs", "close_tab", "close_session",
}

var wantRequired = map[string][]string{
	"navigate":    {"url"},
	"find_tab":    {"url"},
	"click":       {"selector"},
	"fill":        {"selector", "value"},
	"evaluate":    {"code"},
	"network":     {"cmd"},
	"mouse_click": {"selector"},
	"key_type":    {"text"},
	"send_keys":   {"keys"},
	"cdp":         {"method"},
	"upload":      {"selector", "files"},
}

// connectClient 通过 InMemoryTransport 完成 initialize 握手，返回已连接的 client session。
func connectClient(t *testing.T, srv *mcpsdk.Server) *mcpsdk.ClientSession {
	t.Helper()
	ctx := context.Background()
	st, ct := mcpsdk.NewInMemoryTransports()
	ss, err := srv.Connect(ctx, st, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	t.Cleanup(func() { ss.Close() })
	client := mcpsdk.NewClient(&mcpsdk.Implementation{Name: "test-client", Version: "0.0.1"}, nil)
	cs, err := client.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

// TestToolRegistration 验证 initialize + tools/list 握手后返回 17 个工具，名称与协议 §4 一致。
func TestToolRegistration(t *testing.T) {
	srv := NewServer("http://127.0.0.1:1") // 不实际调用
	cs := connectClient(t, srv)

	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(res.Tools) != 17 {
		t.Fatalf("got %d tools, want 17", len(res.Tools))
	}
	got := map[string]*mcpsdk.Tool{}
	for _, tool := range res.Tools {
		got[tool.Name] = tool
	}
	for _, name := range wantTools {
		tool, ok := got[name]
		if !ok {
			t.Errorf("missing tool %q", name)
			continue
		}
		if tool.Description == "" {
			t.Errorf("tool %q has empty description", name)
		}
		schema, err := json.Marshal(tool.InputSchema)
		if err != nil {
			t.Errorf("tool %q schema not marshalable: %v", name, err)
			continue
		}
		if !strings.Contains(string(schema), `"session"`) {
			t.Errorf("tool %q schema missing session property", name)
		}
	}
}

// TestInputSchema 校验每个工具的 inputSchema 必填字段与协议 §4 一致。
func TestInputSchema(t *testing.T) {
	for _, def := range toolDefs {
		schema := def.inputSchema()
		if schema["type"] != "object" {
			t.Errorf("%s: schema type = %v, want object", def.name, schema["type"])
		}
		props, ok := schema["properties"].(map[string]any)
		if !ok {
			t.Fatalf("%s: properties missing", def.name)
		}
		if _, ok := props["session"]; !ok {
			t.Errorf("%s: missing session property", def.name)
		}
		required, _ := schema["required"].([]any)
		gotReq := map[string]bool{}
		for _, r := range required {
			gotReq[r.(string)] = true
		}
		for _, want := range wantRequired[def.name] {
			if !gotReq[want] {
				t.Errorf("%s: required missing %q", def.name, want)
			}
		}
		if len(gotReq) != len(wantRequired[def.name]) {
			t.Errorf("%s: required = %v, want %v", def.name, required, wantRequired[def.name])
		}
	}
}

// fakeDaemon 返回一个 /command 假服务器与收到的请求记录。
func fakeDaemon(t *testing.T, resp string) (*httptest.Server, *commandRequest) {
	t.Helper()
	var got commandRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/command" {
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, resp)
	}))
	t.Cleanup(srv.Close)
	return srv, &got
}

func callTool(t *testing.T, srv *mcpsdk.Server, name string, args map[string]any) *mcpsdk.CallToolResult {
	t.Helper()
	cs := connectClient(t, srv)
	res, err := cs.CallTool(context.Background(), &mcpsdk.CallToolParams{
		Name:      name,
		Arguments: args,
	})
	if err != nil {
		t.Fatalf("CallTool %s: %v", name, err)
	}
	return res
}

func resultText(res *mcpsdk.CallToolResult) string {
	var sb strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcpsdk.TextContent); ok {
			sb.WriteString(tc.Text)
		}
	}
	return sb.String()
}

// TestForwardSuccess 验证 success:true → MCP 成功结果，且 action/args/session 正确转发。
func TestForwardSuccess(t *testing.T) {
	fake, got := fakeDaemon(t, `{"success":true,"data":{"success":true,"url":"https://example.com","tabId":123}}`)
	srv := NewServer(fake.URL)

	res := callTool(t, srv, "navigate", map[string]any{
		"url":     "https://example.com",
		"session": "my-task",
	})
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(res))
	}
	text := resultText(res)
	if !strings.Contains(text, `"tabId": 123`) {
		t.Errorf("result missing data, got: %s", text)
	}
	if got.Action != "navigate" {
		t.Errorf("forwarded action = %q, want navigate", got.Action)
	}
	if got.Session != "my-task" {
		t.Errorf("forwarded session = %q, want my-task", got.Session)
	}
	if got.Args["url"] != "https://example.com" {
		t.Errorf("forwarded args url = %v", got.Args["url"])
	}
	if _, leaked := got.Args["session"]; leaked {
		t.Errorf("session leaked into args: %v", got.Args)
	}
}

// TestForwardDefaultSession 缺省 session 转发为 "default"。
func TestForwardDefaultSession(t *testing.T) {
	fake, got := fakeDaemon(t, `{"success":true,"data":{"success":true,"tabs":[]}}`)
	srv := NewServer(fake.URL)

	res := callTool(t, srv, "list_tabs", nil)
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(res))
	}
	if got.Session != "default" {
		t.Errorf("forwarded session = %q, want default", got.Session)
	}
}

// TestForwardFailure 验证 success:false → MCP 错误结果。
func TestForwardFailure(t *testing.T) {
	fake, _ := fakeDaemon(t, `{"success":false,"error":"click: element not found: #x"}`)
	srv := NewServer(fake.URL)

	res := callTool(t, srv, "click", map[string]any{"selector": "#x"})
	if !res.IsError {
		t.Fatalf("want error result, got: %s", resultText(res))
	}
	if !strings.Contains(resultText(res), "element not found") {
		t.Errorf("error text = %q", resultText(res))
	}
}

// TestForwardUnreachable daemon 不可达时返回带 cdp-bridge start 提示的错误。
func TestForwardUnreachable(t *testing.T) {
	// 申请一个端口后立刻关闭，保证不可达。
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()

	srv := NewServer("http://" + addr)
	res := callTool(t, srv, "list_tabs", nil)
	if !res.IsError {
		t.Fatalf("want error result, got: %s", resultText(res))
	}
	text := resultText(res)
	if !strings.Contains(text, "cdp-bridge start") {
		t.Errorf("error should hint `cdp-bridge start`, got: %s", text)
	}
}

// TestRequiredValidation 缺必填参数时不应发 HTTP 请求，直接返回错误结果。
func TestRequiredValidation(t *testing.T) {
	fake, _ := fakeDaemon(t, `{"success":true,"data":{}}`)
	srv := NewServer(fake.URL)

	res := callTool(t, srv, "navigate", map[string]any{"newTab": true})
	if !res.IsError {
		t.Fatalf("want error result, got: %s", resultText(res))
	}
	if !strings.Contains(resultText(res), "url is required") {
		t.Errorf("error text = %q", resultText(res))
	}
}

// TestScreenshotReadHint screenshot 结果附带 Read 工具提示与文件路径。
func TestScreenshotReadHint(t *testing.T) {
	fake, _ := fakeDaemon(t, `{"success":true,"data":{"format":"png","path":"/tmp/shot.png","sizeBytes":1024}}`)
	srv := NewServer(fake.URL)

	res := callTool(t, srv, "screenshot", map[string]any{})
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(res))
	}
	text := resultText(res)
	if !strings.Contains(text, "/tmp/shot.png") || !strings.Contains(text, "Read tool") {
		t.Errorf("screenshot result should mention path and Read tool, got: %s", text)
	}
}

// TestSaveAsPDFReadHint save_as_pdf 结果附带 Read 工具提示。
func TestSaveAsPDFReadHint(t *testing.T) {
	fake, _ := fakeDaemon(t, `{"success":true,"data":{"path":"/tmp/page.pdf","sizeBytes":2048,"pageTitle":"Demo"}}`)
	srv := NewServer(fake.URL)

	res := callTool(t, srv, "save_as_pdf", map[string]any{})
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(res))
	}
	text := resultText(res)
	if !strings.Contains(text, "/tmp/page.pdf") || !strings.Contains(text, "Read tool") {
		t.Errorf("save_as_pdf result should mention path and Read tool, got: %s", text)
	}
}
