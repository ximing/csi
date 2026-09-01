package ws

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// newTestHub 起随机端口的真实 HTTP server，只挂 /ws。
func newTestHub(t *testing.T) (*Hub, string) {
	t.Helper()
	h := New("test", log.New(io.Discard, "", 0))
	h.PingInterval = time.Hour // 测试里不打心跳
	ts := httptest.NewServer(http.HandlerFunc(h.HandleWS))
	t.Cleanup(ts.Close)
	return h, "ws" + strings.TrimPrefix(ts.URL, "http")
}

func dial(t *testing.T, wsURL string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// dialHello 拨号并完成 hello 握手（发 hello、读 hello_ack）。
// 新连接须先完成握手才会被 Hub 接纳（顶替旧连接）。
func dialHello(t *testing.T, wsURL string) *websocket.Conn {
	t.Helper()
	conn := dial(t, wsURL)
	hello, _ := json.Marshal(map[string]any{"extensionVersion": "0.0.1"})
	if err := conn.WriteJSON(Message{Type: MsgHello, Payload: hello}); err != nil {
		t.Fatalf("send hello: %v", err)
	}
	var ack Message
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatalf("read hello_ack: %v", err)
	}
	if ack.Type != MsgHelloAck {
		t.Fatalf("ack type = %q, want %q", ack.Type, MsgHelloAck)
	}
	return conn
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

func (h *Hub) pendingLen() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.pending)
}

func (h *Hub) currentGen() uint64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.gen
}

// sweepPending 只能唤醒指定代数的在途调用：
// 旧连接（gen1）退出不得误杀新连接（gen2）已注册的调用。
func TestSweepPendingByGen(t *testing.T) {
	t.Parallel()
	h := New("test", log.New(io.Discard, "", 0))
	oldCh := make(chan toolResultPayload, 1)
	newCh := make(chan toolResultPayload, 1)
	h.mu.Lock()
	h.gen = 2 // 已有两代连接
	h.pending["old-req"] = pendingCall{gen: 1, ch: oldCh}
	h.pending["new-req"] = pendingCall{gen: 2, ch: newCh}
	h.mu.Unlock()

	// 旧连接退出清理 gen1
	h.sweepPending(1, ErrNotConnected.Error())

	select {
	case res := <-oldCh:
		if res.Error != ErrNotConnected.Error() {
			t.Fatalf("old pending error = %q", res.Error)
		}
	default:
		t.Fatal("old pending should have been woken")
	}
	select {
	case res := <-newCh:
		t.Fatalf("new pending must not be killed by stale gen, got %+v", res)
	default:
	}
	if h.pendingLen() != 1 {
		t.Fatalf("pending len = %d, want 1 (new-req survives)", h.pendingLen())
	}
	if _, ok := h.pending["new-req"]; !ok {
		t.Fatal("new-req should still be registered")
	}
}

// 真实 WS 握手的 failover 场景：旧连接上的在途调用在新连接踢它时收到
// ErrNotConnected；随后新连接上的调用正常完成，不被旧连接退出影响。
func TestKickThenCallOnNewConn(t *testing.T) {
	t.Parallel()
	h, wsURL := newTestHub(t)

	dialHello(t, wsURL) // 旧连接
	waitFor(t, h.Connected, "first connection")

	// 在旧连接上发起不应答的调用 → pending 属于 gen1
	callErr := make(chan error, 1)
	go func() {
		_, err := h.CallTool(context.Background(), "snapshot", nil)
		callErr <- err
	}()
	waitFor(t, func() bool { return h.pendingLen() == 1 }, "pending registered on old conn")

	// 新连接 hello 握手通过后踢掉旧连接
	c2 := dialHello(t, wsURL)
	waitFor(t, func() bool { return h.currentGen() == 2 }, "second connection registered")

	// 旧连接上的调用应被唤醒报 extension not connected
	select {
	case err := <-callErr:
		if err == nil || err.Error() != ErrNotConnected.Error() {
			t.Fatalf("old call err = %v, want %q", err, ErrNotConnected)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("old call should have been woken after kick")
	}

	// 新连接上的调用：c2 正常应答，应成功返回
	go func() {
		var msg Message
		if err := c2.ReadJSON(&msg); err != nil {
			return
		}
		if msg.Type != MsgToolCall {
			return
		}
		payload, _ := json.Marshal(map[string]any{
			"data": json.RawMessage(`{"ok":true}`),
		})
		_ = c2.WriteJSON(Message{
			Type:                MsgToolResult,
			ResponseToRequestID: msg.RequestID,
			Payload:             payload,
		})
	}()
	res, err := h.CallTool(context.Background(), "snapshot", nil)
	if err != nil {
		t.Fatalf("call on new conn: %v", err)
	}
	if string(res) != `{"ok":true}` {
		t.Fatalf("res = %s", res)
	}
}

// Close 唤醒所有在途调用（报 daemon shutting down），关闭连接，且幂等。
func TestHubClose(t *testing.T) {
	t.Parallel()
	h, wsURL := newTestHub(t)

	dialHello(t, wsURL)
	waitFor(t, h.Connected, "connection")

	callErr := make(chan error, 1)
	go func() {
		_, err := h.CallTool(context.Background(), "snapshot", nil)
		callErr <- err
	}()
	waitFor(t, func() bool { return h.pendingLen() == 1 }, "pending registered")

	h.Close()

	select {
	case err := <-callErr:
		if err == nil || err.Error() != ErrShuttingDown.Error() {
			t.Fatalf("call err = %v, want %q", err, ErrShuttingDown)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pending call should have been woken by Close")
	}
	if h.Connected() {
		t.Fatal("hub should report not connected after Close")
	}

	// 幂等：重复 Close 不 panic
	h.Close()

	// Close 后再调用直接报未连接
	if _, err := h.CallTool(context.Background(), "snapshot", nil); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("call after Close err = %v, want ErrNotConnected", err)
	}
}

// Close() 与进行中的握手竞争：Close 之后才完成 hello 的连接不得被接纳，
// 否则会产生未被本次 Close 清扫的 pending。
func TestCloseDuringHandshake(t *testing.T) {
	t.Parallel()
	h, wsURL := newTestHub(t)

	conn := dial(t, wsURL) // 只拨号，不发 hello，停在握手阶段
	h.Close()

	hello, _ := json.Marshal(map[string]any{"extensionVersion": "0.0.1"})
	if err := conn.WriteJSON(Message{Type: MsgHello, Payload: hello}); err != nil {
		t.Fatalf("send hello: %v", err)
	}

	// 握手"成功"但 daemon 已关闭：连接必须被关闭，而不是装回 Hub
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("connection should be closed after Close, got a message")
	}
	if h.Connected() {
		t.Fatal("hub must stay disconnected after Close")
	}
	if h.currentGen() != 0 {
		t.Fatalf("gen = %d, want 0 (no connection admitted)", h.currentGen())
	}
}

// 未发 hello 的连接不能顶替在位连接：首条消息非 hello 被直接关闭，
// 在位连接仍 Connected、代数不变。
func TestNoHelloCannotKick(t *testing.T) {
	t.Parallel()
	h, wsURL := newTestHub(t)

	dialHello(t, wsURL)
	waitFor(t, h.Connected, "first connection")

	c2 := dial(t, wsURL)
	// 首条消息不是 hello → 服务端直接关闭，不影响在位连接
	if err := c2.WriteJSON(Message{Type: MsgPing}); err != nil {
		t.Fatalf("send non-hello: %v", err)
	}
	_ = c2.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := c2.ReadMessage(); err == nil {
		t.Fatal("non-hello connection should have been closed")
	}
	if !h.Connected() {
		t.Fatal("incumbent connection must survive non-hello dial")
	}
	if got := h.currentGen(); got != 1 {
		t.Fatalf("gen = %d, want 1 (no kick)", got)
	}
}

// 握手超时：一直不发 hello 的连接在 HandshakeTimeout 后被关闭，且从不被接纳。
func TestHandshakeTimeout(t *testing.T) {
	t.Parallel()
	h, wsURL := newTestHub(t)
	h.HandshakeTimeout = 100 * time.Millisecond

	c := dial(t, wsURL)
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := c.ReadMessage(); err == nil {
		t.Fatal("idle handshake connection should have been closed after timeout")
	}
	if h.Connected() {
		t.Fatal("hub must not register connection that never says hello")
	}
}

// hello 握手通过后新连接正常顶替旧连接。
func TestHelloThenKick(t *testing.T) {
	t.Parallel()
	h, wsURL := newTestHub(t)

	c1 := dialHello(t, wsURL)
	waitFor(t, h.Connected, "first connection")
	if got := h.ExtensionVersion(); got != "0.0.1" {
		t.Fatalf("extVersion = %q, want 0.0.1", got)
	}

	dialHello(t, wsURL)
	waitFor(t, func() bool { return h.currentGen() == 2 }, "second connection registered")

	_ = c1.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := c1.ReadMessage(); err == nil {
		t.Fatal("old connection should have been kicked")
	}
	if !h.Connected() {
		t.Fatal("hub should be connected via new connection")
	}
}

// pong 看门狗：客户端不再回任何消息（模拟休眠半死），
// 读超时后 daemon 主动断开，Connected 变 false。
func TestPongWatchdog(t *testing.T) {
	t.Parallel()
	h, wsURL := newTestHub(t)
	h.PingInterval = 50 * time.Millisecond // pongWait = 100ms

	dialHello(t, wsURL)
	waitFor(t, h.Connected, "connection")
	// 客户端此后不读不写，ping 堆积在 TCP 缓冲，daemon 读超时兜底
	waitFor(t, func() bool { return !h.Connected() }, "watchdog closes half-dead connection")
}

func TestHandshakeStoresTools(t *testing.T) {
	h, url := newTestHub(t)
	h.SetDaemonTools([]string{"navigate", "wait"})
	conn := dial(t, url)
	hello, _ := json.Marshal(map[string]any{
		"extensionVersion": "0.4.0",
		"tools":            []string{"navigate", "snapshot"},
	})
	if err := conn.WriteJSON(Message{Type: MsgHello, Payload: hello}); err != nil {
		t.Fatal(err)
	}
	var ack Message
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	var p struct {
		DaemonVersion string   `json:"daemonVersion"`
		Tools         []string `json:"tools"`
	}
	_ = json.Unmarshal(ack.Payload, &p)
	if p.DaemonVersion != "test" {
		t.Fatalf("daemonVersion=%q", p.DaemonVersion)
	}
	if len(p.Tools) != 2 || p.Tools[0] != "navigate" || p.Tools[1] != "wait" {
		t.Fatalf("ack tools=%v", p.Tools)
	}
	waitFor(t, h.Connected, "connected")
	got := h.ExtensionTools()
	if len(got) != 2 || got[0] != "navigate" || got[1] != "snapshot" {
		t.Fatalf("ExtensionTools=%v", got)
	}
}

func TestHandshakeMissingToolsIsNil(t *testing.T) {
	h, url := newTestHub(t)
	_ = dialHello(t, url) // 现有 helper 不带 tools
	waitFor(t, h.Connected, "connected")
	if h.ExtensionTools() != nil {
		t.Fatalf("want nil, got %v", h.ExtensionTools())
	}
}

func TestHandshakeEmptyToolsAdvertised(t *testing.T) {
	h, url := newTestHub(t)
	conn := dial(t, url)
	hello, _ := json.Marshal(map[string]any{
		"extensionVersion": "0.4.0",
		"tools":            []string{},
	})
	if err := conn.WriteJSON(Message{Type: MsgHello, Payload: hello}); err != nil {
		t.Fatal(err)
	}
	var ack Message
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	waitFor(t, h.Connected, "connected")
	got := h.ExtensionTools()
	if got == nil {
		t.Fatal("advertised empty tools must be empty slice, not nil")
	}
	if len(got) != 0 {
		t.Fatalf("ExtensionTools=%v", got)
	}
}

func TestOriginAllowed(t *testing.T) {
	t.Parallel()
	cases := []struct {
		origin string
		want   bool
	}{
		{"", true},
		{"chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef", true},
		{"CHROME-EXTENSION://abcdefghijklmnopqrstuvwxyzabcdef", true},
		{"chrome-extension://", false},
		{"https://evil.example", false},
		{"http://127.0.0.1:3000", false},
		{"http://localhost:10088", false},
		{"http://127.0.0.1:10088", false},
		{"null", false},
		{"file://", false},
	}
	for _, tc := range cases {
		if got := originAllowed(tc.origin); got != tc.want {
			t.Errorf("originAllowed(%q) = %v, want %v", tc.origin, got, tc.want)
		}
	}
}

func TestRejectWebOriginCannotKick(t *testing.T) {
	t.Parallel()
	h, wsURL := newTestHub(t)
	dialHello(t, wsURL)
	waitFor(t, h.Connected, "first connection")
	gen := h.currentGen()

	hdr := http.Header{}
	hdr.Set("Origin", "https://evil.example")
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, hdr)
	if err == nil {
		t.Fatal("web origin should be rejected")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("got resp=%v err=%v, want 403", resp, err)
	}
	if !h.Connected() {
		t.Fatal("incumbent connection must survive rejected origin")
	}
	if got := h.currentGen(); got != gen {
		t.Fatalf("gen = %d, want %d (no kick)", got, gen)
	}
}

func TestChromeExtensionOriginCanHello(t *testing.T) {
	t.Parallel()
	h, wsURL := newTestHub(t)
	hdr := http.Header{}
	hdr.Set("Origin", "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, hdr)
	if err != nil {
		t.Fatalf("extension origin dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	hello, _ := json.Marshal(map[string]any{"extensionVersion": "0.0.1"})
	if err := conn.WriteJSON(Message{Type: MsgHello, Payload: hello}); err != nil {
		t.Fatal(err)
	}
	var ack Message
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	if ack.Type != MsgHelloAck {
		t.Fatalf("ack type = %q, want %q", ack.Type, MsgHelloAck)
	}
	waitFor(t, h.Connected, "connected")
}

// WS 单消息超读上限（协议 §3.2）：daemon 以 code=result_too_large 的 *ToolError
// 唤醒该连接的在途调用并断开连接（不是无声断连），扩展重连后新调用正常。
func TestOversizedFrameFailsPendingWithResultTooLarge(t *testing.T) {
	t.Parallel()
	h, wsURL := newTestHub(t)
	h.MaxReadBytes = 1 << 10 // 测试用 1KB 上限

	conn := dialHello(t, wsURL)
	waitFor(t, h.Connected, "connected")

	errCh := make(chan error, 1)
	go func() {
		_, err := h.CallTool(context.Background(), "evaluate", nil)
		errCh <- err
	}()
	waitFor(t, func() bool { return h.pendingLen() == 1 }, "pending registered")

	// 发一个超过读上限的 tool_result 帧（内容无所谓，frame header 即触发拒收）
	big := strings.Repeat("x", 4<<10)
	payload, _ := json.Marshal(map[string]any{"data": map[string]any{"blob": big}})
	if err := conn.WriteJSON(Message{
		Type:                MsgToolResult,
		ResponseToRequestID: "req-whatever",
		Payload:             payload,
	}); err != nil {
		t.Fatalf("write oversized frame: %v", err)
	}

	select {
	case err := <-errCh:
		var te *ToolError
		if !errors.As(err, &te) {
			t.Fatalf("err type %T %v, want *ToolError", err, err)
		}
		if te.Code != "result_too_large" {
			t.Fatalf("code = %q, want result_too_large", te.Code)
		}
		if !strings.HasPrefix(te.Message, "result too large to deliver: ws transport limit exceeded") {
			t.Fatalf("message = %q, want protocol §2.1 wording", te.Message)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pending call not failed after oversized frame")
	}

	// 连接被关闭（超限帧破坏帧边界，不可恢复），hub 报未连接
	waitFor(t, func() bool { return !h.Connected() }, "connection closed after oversized frame")

	// 扩展 reconcile 重连后：新连接上的调用正常完成，不受旧连接超限影响
	c2 := dialHello(t, wsURL)
	waitFor(t, h.Connected, "reconnected")
	go func() {
		var msg Message
		if err := c2.ReadJSON(&msg); err != nil {
			return
		}
		if msg.Type != MsgToolCall {
			return
		}
		payload, _ := json.Marshal(map[string]any{"data": json.RawMessage(`{"ok":true}`)})
		_ = c2.WriteJSON(Message{Type: MsgToolResult, ResponseToRequestID: msg.RequestID, Payload: payload})
	}()
	res, err := h.CallTool(context.Background(), "snapshot", nil)
	if err != nil {
		t.Fatalf("call on reconnected conn: %v", err)
	}
	if string(res) != `{"ok":true}` {
		t.Fatalf("res = %s", res)
	}
}

// 读上限内的消息不受影响：略低于上限的 tool_result 正常投递。
func TestFrameUnderReadLimitPasses(t *testing.T) {
	t.Parallel()
	h, wsURL := newTestHub(t)
	h.MaxReadBytes = 1 << 20

	conn := dialHello(t, wsURL)
	waitFor(t, h.Connected, "connected")

	errCh := make(chan error, 1)
	var res json.RawMessage
	go func() {
		var err error
		res, err = h.CallTool(context.Background(), "evaluate", nil)
		errCh <- err
	}()

	var msg Message
	if err := conn.ReadJSON(&msg); err != nil {
		t.Fatalf("read tool_call: %v", err)
	}
	payload, _ := json.Marshal(map[string]any{"data": map[string]any{"blob": strings.Repeat("y", 512<<10)}})
	if err := conn.WriteJSON(Message{Type: MsgToolResult, ResponseToRequestID: msg.RequestID, Payload: payload}); err != nil {
		t.Fatalf("write tool_result: %v", err)
	}
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("call: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("CallTool did not return")
	}
	if !strings.Contains(string(res), "yyy") {
		t.Fatalf("res = %.80s...", res)
	}
}

// CallTool 把 tool_result payload 的可选 code/details 解析成 *ToolError
// 传给调用方；无 code 的普通错误仍是裸 error（协议 §3.3）。
func TestCallToolParsesToolErrorCodeDetails(t *testing.T) {
	t.Parallel()
	h, wsURL := newTestHub(t)
	conn := dialHello(t, wsURL)
	waitFor(t, h.Connected, "connected")

	errCh := make(chan error, 1)
	go func() {
		_, err := h.CallTool(context.Background(), "click", map[string]any{"selector": "#x"})
		errCh <- err
	}()

	var msg Message
	if err := conn.ReadJSON(&msg); err != nil {
		t.Fatalf("read tool_call: %v", err)
	}
	if msg.Type != MsgToolCall {
		t.Fatalf("type = %q, want %q", msg.Type, MsgToolCall)
	}
	payload, _ := json.Marshal(map[string]any{
		"error":   "session target tab 99 is no longer available",
		"code":    "stale_target",
		"details": map[string]any{"tabId": 99, "session": "s", "nextTabId": 42},
	})
	if err := conn.WriteJSON(Message{
		Type:                MsgToolResult,
		ResponseToRequestID: msg.RequestID,
		Payload:             payload,
	}); err != nil {
		t.Fatalf("write tool_result: %v", err)
	}

	select {
	case err := <-errCh:
		var te *ToolError
		if !errors.As(err, &te) {
			t.Fatalf("err type %T %v, want *ToolError", err, err)
		}
		if te.Message != "session target tab 99 is no longer available" {
			t.Fatalf("message = %q", te.Message)
		}
		if te.Code != "stale_target" {
			t.Fatalf("code = %q, want stale_target", te.Code)
		}
		if te.Details["nextTabId"].(float64) != 42 || te.Details["tabId"].(float64) != 99 {
			t.Fatalf("details = %v", te.Details)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("CallTool did not return after tool_result")
	}
}

func TestWriteJSONDeadline(t *testing.T) {
	// 服务端 upgrade 后不读任何数据
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		time.Sleep(5 * time.Second) // 持连接不读
	}))
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	h := New("test", log.New(io.Discard, "", 0))
	h.WriteTimeout = 100 * time.Millisecond
	// 必须是合法 JSON 大帧（零字节不是合法 JSON，WriteJSON 会在 marshal 阶段秒报错，
	// 根本走不到网络写，测试实现前后都绿、红绿门失效）——用 8MB 的 JSON 字符串。
	big := json.RawMessage(`"` + strings.Repeat("a", 8<<20) + `"`)
	start := time.Now()
	err = h.writeJSON(conn, Message{Type: MsgToolCall, Payload: big})
	if err == nil {
		t.Fatal("期望写超时错误")
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("写阻塞 %.1fs,deadline 未生效", d.Seconds())
	}
}
