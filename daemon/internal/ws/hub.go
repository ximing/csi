// Package ws 实现与 Chrome 扩展之间的 WebSocket 通道（协议 §3）。
// 同一时间只接受一个扩展连接，新连接完成 hello 握手后踢掉旧连接。
package ws

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// 消息类型（协议 §3.3）。
const (
	MsgHello      = "hello"
	MsgHelloAck   = "hello_ack"
	MsgPing       = "ping"
	MsgPong       = "pong"
	MsgToolCall   = "tool_call"
	MsgToolResult = "tool_result"
)

// ErrNotConnected 扩展未连接。
var ErrNotConnected = errors.New("extension not connected")

// ErrShuttingDown daemon 正在关闭（Close 唤醒在途调用时使用）。
var ErrShuttingDown = errors.New("daemon shutting down")

// Message 顶层消息结构（协议 §3.2）。
type Message struct {
	Type                string          `json:"type"`
	RequestID           string          `json:"requestId,omitempty"`
	ResponseToRequestID string          `json:"responseToRequestId,omitempty"`
	Payload             json.RawMessage `json:"payload,omitempty"`
}

// toolResultPayload tool_result 的 payload：{data} 或 {error}。
type toolResultPayload struct {
	Data  json.RawMessage `json:"data"`
	Error string          `json:"error"`
}

// pendingCall 在途的 tool_call，带连接代数：
// 旧连接被踢退出时只能唤醒属于自己代数的调用，避免误杀新连接的在途调用。
type pendingCall struct {
	gen uint64
	ch  chan toolResultPayload
}

// Hub 管理唯一的扩展 WS 连接及 tool_call 请求/响应关联。
type Hub struct {
	Version          string        // hello_ack 中告知扩展的 daemon 版本
	ToolTimeout      time.Duration // 工具调用超时，默认 120s（协议 §3.3）
	PingInterval     time.Duration // 应用层 ping 间隔，默认 30s
	HandshakeTimeout time.Duration // hello 握手超时，默认 5s
	Logger           *log.Logger

	mu            sync.Mutex
	conn          *websocket.Conn
	gen           uint64 // 连接代数，setConn 时递增
	extVersion    string
	daemonTools   []string
	extTools      []string
	extAdvertised bool
	pending       map[string]pendingCall

	writeMu sync.Mutex // 写帧串行化（ping 与 tool_call 并发写）
	counter atomic.Uint64
}

// New 创建 Hub。
func New(daemonVersion string, logger *log.Logger) *Hub {
	if logger == nil {
		logger = log.Default()
	}
	return &Hub{
		Version:          daemonVersion,
		ToolTimeout:      120 * time.Second,
		PingInterval:     30 * time.Second,
		HandshakeTimeout: 5 * time.Second,
		Logger:           logger,
		pending:          make(map[string]pendingCall),
	}
}

// SetToolTimeout 更新工具调用超时（持锁，POST /config 运行期即时生效）。
func (h *Hub) SetToolTimeout(d time.Duration) {
	h.mu.Lock()
	h.ToolTimeout = d
	h.mu.Unlock()
}

// ToolTimeoutDuration 返回当前工具调用超时（持锁，供测试/外部观察）。
func (h *Hub) ToolTimeoutDuration() time.Duration {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.ToolTimeout
}

// Connected 扩展当前是否已连接。
func (h *Hub) Connected() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.conn != nil
}

// ExtensionVersion 扩展 hello 上报的版本。
func (h *Hub) ExtensionVersion() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.extVersion
}

// SetDaemonTools 存一份拷贝，hello_ack.tools 回给扩展（协议 §3.3）。
func (h *Hub) SetDaemonTools(names []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.daemonTools = append([]string(nil), names...)
}

// ExtensionTools 扩展 hello 上报的工具清单。未上报返回 nil；上报了返回拷贝（可为空切片）。
func (h *Hub) ExtensionTools() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.extAdvertised {
		return nil
	}
	out := make([]string, len(h.extTools))
	copy(out, h.extTools)
	return out
}

var upgrader = websocket.Upgrader{
	// v1 无认证，仅依赖 127.0.0.1 回环隔离（协议 §7），不做 Origin 校验。
	CheckOrigin: func(r *http.Request) bool { return true },
}

// HandleWS 处理 /ws 端点。首条消息必须是 hello，握手通过后才顶替旧连接。
func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.Logger.Printf("ws upgrade failed: %v", err)
		return
	}
	extVersion, tools, ok := h.handshake(conn)
	if !ok {
		conn.Close() // 未通过 hello 校验，不动在位连接
		return
	}
	gen := h.setConn(conn, extVersion, tools)
	h.Logger.Printf("extension hello, version=%q", extVersion)
	// 握手完成，转入 pong 看门狗：每读到一条消息续期读超时
	_ = conn.SetReadDeadline(time.Now().Add(h.pongWait()))
	h.mu.Lock()
	ackTools := h.daemonTools
	h.mu.Unlock()
	ack, _ := json.Marshal(map[string]any{
		"daemonVersion": h.Version,
		"tools":         ackTools,
	})
	if err := h.writeJSON(conn, Message{Type: MsgHelloAck, Payload: ack}); err != nil {
		h.connDone(conn, gen)
		return
	}
	go h.pingLoop(conn)
	h.readLoop(conn, gen) // 阻塞直至连接断开
}

// handshake 握手阶段（协议 §3.3）：首条消息必须是 hello，返回扩展版本与可选 tools。
// 任何失败（非 hello、读超时）都返回 false，由调用方直接关闭连接、
// 不顶替在位连接——防止端口扫描、误连把真扩展挤下线。
func (h *Hub) handshake(conn *websocket.Conn) (version string, tools *[]string, ok bool) {
	timeout := h.HandshakeTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	_, data, err := conn.ReadMessage()
	if err != nil {
		h.Logger.Printf("ws: handshake read failed (expect hello): %v", err)
		return "", nil, false
	}
	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil || msg.Type != MsgHello {
		h.Logger.Printf("ws: first message is not hello, closing")
		return "", nil, false
	}
	var p struct {
		ExtensionVersion string    `json:"extensionVersion"`
		Tools            *[]string `json:"tools"`
	}
	_ = json.Unmarshal(msg.Payload, &p)
	return p.ExtensionVersion, p.Tools, true
}

// pongWait 读超时阈值：2 倍 ping 间隔。pong 及其它消息都算活跃证据。
func (h *Hub) pongWait() time.Duration {
	return 2 * h.PingInterval
}

// setConn 握手通过后换绑新连接并递增代数，返回新连接的代数。
// tools 非 nil 视为扩展上报了清单（可为空）；nil 表示未上报。
func (h *Hub) setConn(conn *websocket.Conn, extVersion string, tools *[]string) uint64 {
	h.mu.Lock()
	h.gen++
	gen := h.gen
	old := h.conn
	h.conn = conn
	h.extVersion = extVersion
	if tools != nil {
		h.extAdvertised = true
		h.extTools = make([]string, len(*tools))
		copy(h.extTools, *tools)
	} else {
		h.extAdvertised = false
		h.extTools = nil
	}
	h.mu.Unlock()
	if old != nil && old != conn {
		h.Logger.Printf("new extension connected, kicking old connection")
		old.Close() // 旧连接的 readLoop 会按代数清理自己的 pending
	}
	return gen
}

// readLoop 读循环：pong / tool_result。首条 hello 已在握手阶段处理。
func (h *Hub) readLoop(conn *websocket.Conn, gen uint64) {
	// 清理 defer 先注册、recover 后注册：panic 时 recover 先执行，清理仍会执行。
	defer h.connDone(conn, gen)
	defer func() {
		if r := recover(); r != nil {
			h.Logger.Printf("ws: panic in readLoop: %v", r)
		}
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				// pong 看门狗：半死连接主动断开，扩展侧 reconcile 会重连
				h.Logger.Printf("extension read timeout, closing")
			}
			return
		}
		// 每读到一条消息都算活跃证据，续期读超时
		_ = conn.SetReadDeadline(time.Now().Add(h.pongWait()))
		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			h.Logger.Printf("ws: bad message: %v", err)
			continue
		}
		switch msg.Type {
		case MsgHello:
			// 重复 hello 忽略（握手已完成）
			h.Logger.Printf("ws: duplicate hello ignored")
		case MsgPong:
			// 心跳应答，无需处理
		case MsgToolResult:
			h.mu.Lock()
			pc, ok := h.pending[msg.ResponseToRequestID]
			if ok {
				delete(h.pending, msg.ResponseToRequestID)
			}
			h.mu.Unlock()
			if !ok {
				h.Logger.Printf("ws: tool_result for unknown requestId %q", msg.ResponseToRequestID)
				continue
			}
			var p toolResultPayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				p = toolResultPayload{Error: "bad tool_result payload: " + err.Error()}
			}
			pc.ch <- p
		default:
			// 未知类型忽略（协议 §3.3）
			h.Logger.Printf("ws: ignore unknown message type %q", msg.Type)
		}
	}
}

// connDone 连接退出清理：仅唤醒属于本连接代数的 pending，
// 避免被踢的旧连接退出时误杀新连接已注册的在途调用。
func (h *Hub) connDone(conn *websocket.Conn, gen uint64) {
	h.mu.Lock()
	same := h.conn == conn
	if same {
		h.conn = nil
		h.extVersion = ""
		h.extAdvertised = false
		h.extTools = nil
	}
	h.mu.Unlock()
	h.sweepPending(gen, ErrNotConnected.Error())
	conn.Close()
	if same {
		h.Logger.Printf("extension disconnected")
	}
}

// sweepPending 唤醒并移除指定代数的所有在途调用。
func (h *Hub) sweepPending(gen uint64, errMsg string) {
	h.mu.Lock()
	var chans []chan toolResultPayload
	for id, pc := range h.pending {
		if pc.gen == gen {
			chans = append(chans, pc.ch)
			delete(h.pending, id)
		}
	}
	h.mu.Unlock()
	for _, ch := range chans {
		ch <- toolResultPayload{Error: errMsg}
	}
}

// Close 关闭当前扩展连接并唤醒所有在途调用（报 "daemon shutting down"）。幂等。
func (h *Hub) Close() {
	h.mu.Lock()
	conn := h.conn
	h.conn = nil
	h.extVersion = ""
	h.extAdvertised = false
	h.extTools = nil
	pending := h.pending
	h.pending = make(map[string]pendingCall)
	h.mu.Unlock()
	for _, pc := range pending {
		pc.ch <- toolResultPayload{Error: ErrShuttingDown.Error()}
	}
	if conn != nil {
		conn.Close()
	}
}

// pingLoop 每 PingInterval 发送应用层 ping。
func (h *Hub) pingLoop(conn *websocket.Conn) {
	defer func() {
		if r := recover(); r != nil {
			h.Logger.Printf("ws: panic in pingLoop: %v", r)
		}
	}()
	t := time.NewTicker(h.PingInterval)
	defer t.Stop()
	for range t.C {
		h.mu.Lock()
		cur := h.conn
		h.mu.Unlock()
		if cur != conn {
			return
		}
		if err := h.writeJSON(conn, Message{Type: MsgPing}); err != nil {
			return
		}
	}
}

func (h *Hub) writeJSON(conn *websocket.Conn, msg Message) error {
	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	return conn.WriteJSON(msg)
}

func (h *Hub) removePending(id string) {
	h.mu.Lock()
	delete(h.pending, id)
	h.mu.Unlock()
}

// CallTool 向扩展发送 tool_call 并等待 tool_result（requestId 关联）。
func (h *Hub) CallTool(ctx context.Context, name string, args map[string]any) (json.RawMessage, error) {
	h.mu.Lock()
	conn := h.conn
	if conn == nil {
		h.mu.Unlock()
		return nil, ErrNotConnected
	}
	id := newRequestID(h.counter.Add(1))
	ch := make(chan toolResultPayload, 1)
	h.pending[id] = pendingCall{gen: h.gen, ch: ch}
	h.mu.Unlock()

	payload, _ := json.Marshal(map[string]any{"name": name, "args": args})
	if err := h.writeJSON(conn, Message{Type: MsgToolCall, RequestID: id, Payload: payload}); err != nil {
		h.removePending(id)
		return nil, err
	}

	timeout := h.ToolTimeoutDuration()
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case res := <-ch:
		if res.Error != "" {
			return nil, errors.New(res.Error)
		}
		return res.Data, nil
	case <-ctx.Done():
		h.removePending(id)
		return nil, ctx.Err()
	case <-timer.C:
		h.removePending(id)
		return nil, fmt.Errorf("tool call timeout (%ds)", int(timeout.Seconds()))
	}
}

func newRequestID(n uint64) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("req-%s-%d", hex.EncodeToString(b[:]), n)
}
