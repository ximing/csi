package server_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"csi/daemon/internal/daemon"
	"csi/daemon/internal/server"
	"csi/daemon/internal/tools"
	"csi/daemon/internal/ws"
)

// newTestServer 起随机端口的真实 HTTP server（不占 10088）。
func newTestServer(t *testing.T) (*server.Server, *httptest.Server) {
	t.Helper()
	cfg, err := daemon.LoadConfig(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := server.New(cfg, t.TempDir(), nil)
	srv.Hub.PingInterval = time.Hour // 测试里不打心跳
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, ts
}

// fakeExt 模拟扩展客户端：连接 /ws、发 hello、按 handler 应答 tool_call。
type fakeExt struct {
	t    *testing.T
	conn *websocket.Conn

	mu      sync.Mutex
	handler func(name string, args map[string]any) (any, string) // 返回 (data, errMsg)

	lastArgsMu sync.Mutex
	lastArgs   map[string]any
}

func connectExt(t *testing.T, ts *httptest.Server, handler func(name string, args map[string]any) (any, string)) *fakeExt {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	ext := &fakeExt{t: t, conn: conn, handler: handler}
	t.Cleanup(func() { conn.Close() })

	hello, _ := json.Marshal(map[string]any{"extensionVersion": "0.1.0"})
	if err := conn.WriteJSON(ws.Message{Type: ws.MsgHello, Payload: hello}); err != nil {
		t.Fatalf("send hello: %v", err)
	}
	go ext.readLoop()
	return ext
}

func (e *fakeExt) readLoop() {
	for {
		var msg ws.Message
		if err := e.conn.ReadJSON(&msg); err != nil {
			return
		}
		switch msg.Type {
		case ws.MsgToolCall:
			var p struct {
				Name string         `json:"name"`
				Args map[string]any `json:"args"`
			}
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				continue
			}
			e.lastArgsMu.Lock()
			e.lastArgs = p.Args
			e.lastArgsMu.Unlock()

			e.mu.Lock()
			h := e.handler
			e.mu.Unlock()
			if h == nil {
				continue // 不应答 → 触发超时
			}
			data, errMsg := h(p.Name, p.Args)
			var payload []byte
			if errMsg != "" {
				payload, _ = json.Marshal(map[string]any{"error": errMsg})
			} else {
				d, _ := json.Marshal(data)
				payload, _ = json.Marshal(map[string]any{"data": json.RawMessage(d)})
			}
			_ = e.conn.WriteJSON(ws.Message{
				Type:                ws.MsgToolResult,
				ResponseToRequestID: msg.RequestID,
				Payload:             payload,
			})
		}
	}
}

func (e *fakeExt) lastCallArgs() map[string]any {
	e.lastArgsMu.Lock()
	defer e.lastArgsMu.Unlock()
	return e.lastArgs
}

// postCommand 发送 /command 并解析响应。
func postCommand(t *testing.T, ts *httptest.Server, body string) map[string]any {
	t.Helper()
	resp, err := http.Post(ts.URL+"/command", "application/json", bytes.NewBufferString(body))
	if err != nil {
		t.Fatalf("post /command: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/command status = %d, body %s", resp.StatusCode, raw)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("bad /command json: %v, body %s", err, raw)
	}
	return out
}

func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

func TestToolCallSuccess(t *testing.T) {
	t.Parallel()
	srv, ts := newTestServer(t)
	ext := connectExt(t, ts, func(name string, args map[string]any) (any, string) {
		return map[string]any{"success": true, "url": "https://example.com", "tabId": 123}, ""
	})
	waitFor(t, srv.Hub.Connected, "extension connected")

	resp := postCommand(t, ts, `{"action":"navigate","args":{"url":"https://example.com","newTab":true},"session":"my-task"}`)
	if resp["success"] != true {
		t.Fatalf("success = %v, resp %v", resp["success"], resp)
	}
	data := resp["data"].(map[string]any)
	if data["tabId"].(float64) != 123 {
		t.Fatalf("tabId = %v", data["tabId"])
	}

	// 校验注入字段（协议 §3.4）
	args := ext.lastCallArgs()
	if args["_session"] != "my-task" {
		t.Fatalf("_session = %v", args["_session"])
	}
	if args["_tabId"].(float64) != 0 {
		t.Fatalf("_tabId = %v (first call, want 0)", args["_tabId"])
	}
	if ids, ok := args["_tabIds"].([]any); !ok || len(ids) != 0 {
		t.Fatalf("_tabIds = %v (first call, want [])", args["_tabIds"])
	}
	if args["url"] != "https://example.com" {
		t.Fatalf("url arg lost: %v", args)
	}

	// 第二次调用：session 应记住 tabId=123
	resp = postCommand(t, ts, `{"action":"snapshot","session":"my-task"}`)
	if resp["success"] != true {
		t.Fatalf("second call failed: %v", resp)
	}
	args = ext.lastCallArgs()
	if args["_tabId"].(float64) != 123 {
		t.Fatalf("_tabId = %v (want 123 after navigate)", args["_tabId"])
	}
	ids := args["_tabIds"].([]any)
	if len(ids) != 1 || ids[0].(float64) != 123 {
		t.Fatalf("_tabIds = %v (want [123])", args["_tabIds"])
	}
}

func TestToolCallError(t *testing.T) {
	t.Parallel()
	srv, ts := newTestServer(t)
	connectExt(t, ts, func(name string, args map[string]any) (any, string) {
		return nil, "click: element not found: #x"
	})
	waitFor(t, srv.Hub.Connected, "extension connected")

	resp := postCommand(t, ts, `{"action":"click","args":{"selector":"#x"}}`)
	if resp["success"] != false {
		t.Fatalf("success = %v", resp["success"])
	}
	if resp["error"] != "click: element not found: #x" {
		t.Fatalf("error = %v", resp["error"])
	}
}

func TestToolCallTimeout(t *testing.T) {
	t.Parallel()
	srv, ts := newTestServer(t)
	srv.Hub.SetToolTimeout(300 * time.Millisecond)
	connectExt(t, ts, nil) // 不应答
	waitFor(t, srv.Hub.Connected, "extension connected")

	resp := postCommand(t, ts, `{"action":"snapshot"}`)
	if resp["success"] != false {
		t.Fatalf("success = %v", resp["success"])
	}
	errMsg, _ := resp["error"].(string)
	if !strings.Contains(errMsg, "tool call timeout") {
		t.Fatalf("error = %q, want timeout", errMsg)
	}
}

func TestSessionDefaultAndInjection(t *testing.T) {
	t.Parallel()
	srv, ts := newTestServer(t)
	ext := connectExt(t, ts, func(name string, args map[string]any) (any, string) {
		return map[string]any{"success": true, "tabId": 7}, ""
	})
	waitFor(t, srv.Hub.Connected, "extension connected")

	// 不传 session → default；调用方传 _ 前缀字段应被覆盖
	resp := postCommand(t, ts, `{"action":"navigate","args":{"url":"https://a.com","_session":"evil","_tabId":999}}`)
	if resp["success"] != true {
		t.Fatalf("resp = %v", resp)
	}
	args := ext.lastCallArgs()
	if args["_session"] != "default" {
		t.Fatalf("_session = %v (want default, caller value must be overridden)", args["_session"])
	}
	if args["_tabId"].(float64) != 0 {
		t.Fatalf("_tabId = %v (caller value must be overridden)", args["_tabId"])
	}

	// close_tab 后 session 移除 tabId
	resp = postCommand(t, ts, `{"action":"close_tab"}`)
	if resp["success"] != true {
		t.Fatalf("close_tab resp = %v", resp)
	}
	snap := srv.Sessions.Snapshot("default")
	if len(snap.TabIDs) != 0 || snap.LastTabID != 0 {
		t.Fatalf("after close_tab: %+v (want empty)", snap)
	}
}

func TestScreenshotSavedToDisk(t *testing.T) {
	t.Parallel()
	srv, ts := newTestServer(t)
	pngBytes := []byte("fake-png-bytes")
	connectExt(t, ts, func(name string, args map[string]any) (any, string) {
		return map[string]any{
			"format":     "png",
			"dataLength": len(pngBytes),
			"data":       base64.StdEncoding.EncodeToString(pngBytes),
		}, ""
	})
	waitFor(t, srv.Hub.Connected, "extension connected")

	// args.path 优先，父目录自动创建
	outPath := filepath.Join(t.TempDir(), "sub", "dir", "shot.png")
	body := fmt.Sprintf(`{"action":"screenshot","args":{"path":%q}}`, outPath)
	resp := postCommand(t, ts, body)
	if resp["success"] != true {
		t.Fatalf("resp = %v", resp)
	}
	data := resp["data"].(map[string]any)
	if data["path"] != outPath {
		t.Fatalf("path = %v", data["path"])
	}
	if data["sizeBytes"].(float64) != float64(len(pngBytes)) {
		t.Fatalf("sizeBytes = %v", data["sizeBytes"])
	}
	if data["mimeType"] != "image/png" {
		t.Fatalf("mimeType = %v", data["mimeType"])
	}
	got, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("read saved screenshot: %v", err)
	}
	if !bytes.Equal(got, pngBytes) {
		t.Fatalf("saved content mismatch: %q", got)
	}
}

func TestUnknownTool(t *testing.T) {
	t.Parallel()
	_, ts := newTestServer(t)
	resp := postCommand(t, ts, `{"action":"not_a_tool"}`)
	if resp["success"] != false {
		t.Fatalf("success = %v", resp["success"])
	}
	if resp["error"] != "unknown tool: not_a_tool" {
		t.Fatalf("error = %v", resp["error"])
	}
}

func TestExtensionNotConnected(t *testing.T) {
	t.Parallel()
	_, ts := newTestServer(t)
	resp := postCommand(t, ts, `{"action":"navigate","args":{"url":"https://example.com"}}`)
	if resp["success"] != false {
		t.Fatalf("success = %v", resp["success"])
	}
	if resp["error"] != "extension not connected" {
		t.Fatalf("error = %v", resp["error"])
	}
}

func TestExtensionNotConnectedWait(t *testing.T) {
	t.Parallel()
	_, ts := newTestServer(t)
	resp := postCommand(t, ts, `{"action":"wait","args":{"text":"x"}}`)
	if resp["success"] != false {
		t.Fatalf("success = %v", resp["success"])
	}
	errStr, _ := resp["error"].(string)
	if errStr != "extension not connected" {
		t.Fatalf("error = %q", errStr)
	}
	if strings.Contains(errStr, "does not implement") {
		t.Fatalf("upgrade wording leaked: %q", errStr)
	}
}

func TestHelloAckAndStatus(t *testing.T) {
	t.Parallel()
	srv, ts := newTestServer(t)

	// 手动发 hello，验证 hello_ack
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	defer conn.Close()
	hello, _ := json.Marshal(map[string]any{"extensionVersion": "9.9.9"})
	if err := conn.WriteJSON(ws.Message{Type: ws.MsgHello, Payload: hello}); err != nil {
		t.Fatal(err)
	}
	var ack ws.Message
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatalf("read hello_ack: %v", err)
	}
	if ack.Type != ws.MsgHelloAck {
		t.Fatalf("ack type = %q", ack.Type)
	}
	var p map[string]any
	_ = json.Unmarshal(ack.Payload, &p)
	if p["daemonVersion"] != "0.4.0" {
		t.Fatalf("daemonVersion = %v", p["daemonVersion"])
	}
	gotAckTools, ok := p["tools"].([]any)
	if !ok {
		t.Fatalf("hello_ack.tools = %v", p["tools"])
	}
	wantAckTools := tools.Names()
	if len(gotAckTools) != len(wantAckTools) {
		t.Fatalf("hello_ack.tools = %v, want %v", gotAckTools, wantAckTools)
	}
	for i, n := range wantAckTools {
		if gotAckTools[i] != n {
			t.Fatalf("hello_ack.tools = %v, want %v", gotAckTools, wantAckTools)
		}
	}
	waitFor(t, srv.Hub.Connected, "extension connected")

	// /status 应反映扩展连接状态
	resp, err := http.Get(ts.URL + "/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var st map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&st)
	if st["running"] != true || st["version"] != "0.4.0" {
		t.Fatalf("status = %v", st)
	}
	// 测试 server 与用例同进程，pid 应等于当前进程
	if st["pid"].(float64) != float64(os.Getpid()) {
		t.Fatalf("pid = %v (want %d)", st["pid"], os.Getpid())
	}
	if st["extension_connected"] != true || st["extension_version"] != "9.9.9" {
		t.Fatalf("status ext fields = %v", st)
	}
	if st["extension_tools"] != nil {
		t.Fatalf("extension_tools = %v, want nil", st["extension_tools"])
	}
	if _, ok := st["sessions"].([]any); !ok {
		t.Fatalf("sessions field = %v", st["sessions"])
	}

	// /healthz
	resp2, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	body, _ := io.ReadAll(resp2.Body)
	if resp2.StatusCode != http.StatusOK || string(body) != "ok" {
		t.Fatalf("healthz = %d %q", resp2.StatusCode, body)
	}
}

func TestStatusExtensionToolsAdvertised(t *testing.T) {
	t.Parallel()
	srv, ts := newTestServer(t)

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	defer conn.Close()
	hello, _ := json.Marshal(map[string]any{
		"extensionVersion": "9.9.9",
		"tools":            []string{"navigate", "snapshot"},
	})
	if err := conn.WriteJSON(ws.Message{Type: ws.MsgHello, Payload: hello}); err != nil {
		t.Fatal(err)
	}
	var ack ws.Message
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatalf("read hello_ack: %v", err)
	}
	waitFor(t, srv.Hub.Connected, "extension connected")

	resp, err := http.Get(ts.URL + "/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var st map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&st)
	got, ok := st["extension_tools"].([]any)
	if !ok {
		t.Fatalf("extension_tools = %v (%T)", st["extension_tools"], st["extension_tools"])
	}
	if len(got) != 2 || got[0] != "navigate" || got[1] != "snapshot" {
		t.Fatalf("extension_tools = %v", got)
	}
}

// sendHello 发送 hello 并读 hello_ack。
// 新连接须先完成 hello 握手才会顶替旧连接（协议 §3.1）。
func sendHello(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	hello, _ := json.Marshal(map[string]any{"extensionVersion": "0.1.0"})
	if err := conn.WriteJSON(ws.Message{Type: ws.MsgHello, Payload: hello}); err != nil {
		t.Fatalf("send hello: %v", err)
	}
	var ack ws.Message
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatalf("read hello_ack: %v", err)
	}
	if ack.Type != ws.MsgHelloAck {
		t.Fatalf("ack type = %q, want %q", ack.Type, ws.MsgHelloAck)
	}
}

// GET /config：返回值与来源。
func TestGetConfig(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rc, _ := daemon.LoadConfig(dir)
	srv := server.New(rc, dir, nil)
	req := httptest.NewRequest("GET", "/config", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	var body map[string]map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if body["port"]["value"].(float64) != 10088 || body["port"]["source"] != "default" {
		t.Fatalf("port entry = %+v", body["port"])
	}
}

// POST /config：改超时即时生效（Hub.ToolTimeout 变化），改端口要求重启。
func TestPostConfig(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rc, _ := daemon.LoadConfig(dir)
	srv := server.New(rc, dir, nil)

	post := func(payload string) map[string]any {
		req := httptest.NewRequest("POST", "/config", strings.NewReader(payload))
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, req)
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("parse: %v", err)
		}
		return body
	}

	bad := post(`{"port": 0}`)
	if bad["success"].(bool) {
		t.Fatal("port=0 should be rejected")
	}

	ok := post(`{"tool_timeout_seconds": 60, "log_retention_days": 7, "port": 10090}`)
	if !ok["success"].(bool) {
		t.Fatalf("post failed: %v", ok)
	}
	if ok["data"].(map[string]any)["restart_required"].(bool) != true {
		t.Fatal("port change should require restart")
	}
	if srv.Hub.ToolTimeoutDuration() != 60*time.Second {
		t.Fatalf("ToolTimeout = %v, want 60s", srv.Hub.ToolTimeoutDuration())
	}
	// 落盘可回读
	back, err := daemon.LoadConfig(dir)
	if err != nil || back.Values.Port != 10090 || back.Values.LogRetentionDays != 7 {
		t.Fatalf("reload = %+v, err %v", back, err)
	}
	// 不含端口的修改不要求重启
	ok2 := post(`{"tool_timeout_seconds": 90}`)
	if ok2["data"].(map[string]any)["restart_required"].(bool) != false {
		t.Fatal("non-port change should not require restart")
	}
}

// 二次保存：第一次改端口后 restart_required=true；第二次保存无关字段
// （请求仍带新端口）时 restart_required 仍应为 true——判定应对齐实际
// 监听端口 s.Port，而非内存中已被上一次保存覆盖的 config 值。
func TestPostConfigRestartRequiredSticky(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rc, _ := daemon.LoadConfig(dir)
	srv := server.New(rc, dir, nil)

	post := func(payload string) map[string]any {
		req := httptest.NewRequest("POST", "/config", strings.NewReader(payload))
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, req)
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("parse: %v", err)
		}
		if !body["success"].(bool) {
			t.Fatalf("post %s failed: %v", payload, body)
		}
		return body
	}

	first := post(`{"port": 10090}`)
	if first["data"].(map[string]any)["restart_required"].(bool) != true {
		t.Fatal("first port change should require restart")
	}
	second := post(`{"log_retention_days": 7, "port": 10090}`)
	if second["data"].(map[string]any)["restart_required"].(bool) != true {
		t.Fatal("second save with pending port change should still report restart_required")
	}
}

// env 覆盖端口时保存无关字段：落盘的 config.json 不应把 env 端口固化进去，
// 内存生效值仍为 env 值。
func TestPostConfigEnvPortNotPersisted(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CSI_PORT", "20000")
	rc, _ := daemon.LoadConfig(dir)
	srv := server.New(rc, dir, nil)

	req := httptest.NewRequest("POST", "/config", strings.NewReader(`{"tool_timeout_seconds": 60}`))
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !body["success"].(bool) {
		t.Fatalf("post failed: %v", body)
	}

	data, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("read config.json: %v", err)
	}
	var file daemon.Config
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("parse config.json: %v", err)
	}
	if file.Port != daemon.DefaultPort {
		t.Fatalf("disk port = %d, want default %d (env override must not be persisted)", file.Port, daemon.DefaultPort)
	}
	if file.ToolTimeoutSeconds != 60 {
		t.Fatalf("disk tool_timeout_seconds = %d, want 60", file.ToolTimeoutSeconds)
	}
	// 内存生效值保持 env 覆盖
	if srv.Port != 20000 {
		t.Fatalf("effective port = %d, want env override 20000", srv.Port)
	}
}

// 端口被 CSI_PORT 覆盖时拒绝修改端口。
func TestPostConfigPortLockedByEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CSI_PORT", "20000")
	rc, _ := daemon.LoadConfig(dir)
	srv := server.New(rc, dir, nil)
	req := httptest.NewRequest("POST", "/config", strings.NewReader(`{"port": 10090}`))
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	var body map[string]any
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["success"].(bool) || !strings.Contains(body["error"].(string), "CSI_PORT") {
		t.Fatalf("env-locked port should be rejected with CSI_PORT hint, got %v", body)
	}
}

func TestNewConnectionKicksOld(t *testing.T) {
	t.Parallel()
	srv, ts := newTestServer(t)
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	conn1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn1.Close()
	sendHello(t, conn1)
	waitFor(t, srv.Hub.Connected, "first connection")

	conn2, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn2.Close()
	sendHello(t, conn2)

	// 旧连接应被踢掉
	_ = conn1.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn1.ReadMessage(); err == nil {
		t.Fatal("old connection should have been closed")
	}
	if !srv.Hub.Connected() {
		t.Fatal("hub should still be connected via new connection")
	}
}

// POST /restart：Restarter 被调用；未设置时返回明确错误。
func TestRestartEndpoint(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rc, _ := daemon.LoadConfig(dir)
	srv := server.New(rc, dir, nil)

	// 未设置 Restarter
	req := httptest.NewRequest("POST", "/restart", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	var body map[string]any
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["success"].(bool) {
		t.Fatal("restart without Restarter should fail")
	}

	// 设置后被调用
	called := false
	srv.Restarter = func() error { called = true; return nil }
	w2 := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w2, httptest.NewRequest("POST", "/restart", nil))
	json.Unmarshal(w2.Body.Bytes(), &body)
	if !body["success"].(bool) || !called {
		t.Fatalf("restart should call Restarter and succeed, got %v called=%v", body, called)
	}
}
