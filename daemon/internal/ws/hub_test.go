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

	dial(t, wsURL) // 旧连接
	waitFor(t, h.Connected, "first connection")

	// 在旧连接上发起不应答的调用 → pending 属于 gen1
	callErr := make(chan error, 1)
	go func() {
		_, err := h.CallTool(context.Background(), "snapshot", nil)
		callErr <- err
	}()
	waitFor(t, func() bool { return h.pendingLen() == 1 }, "pending registered on old conn")

	// 新连接踢掉旧连接
	c2 := dial(t, wsURL)
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

	dial(t, wsURL)
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
