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
