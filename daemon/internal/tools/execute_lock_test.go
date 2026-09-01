package tools

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"csi/daemon/internal/session"
	"csi/daemon/internal/ws"
)

type captureBE struct {
	mu       sync.Mutex
	calls    []map[string]any
	first    chan struct{}
	inflight atomic.Int32
	max      atomic.Int32
	block    chan struct{}
	mode     string // "fifo" | "overlap"
}

func (c *captureBE) Name() string    { return "capture" }
func (c *captureBE) Connected() bool { return true }

func (c *captureBE) CallTool(_ context.Context, _ string, args map[string]any) (any, error) {
	copied := make(map[string]any, len(args))
	for k, v := range args {
		copied[k] = v
	}
	n := int(c.inflight.Add(1))
	for {
		cur := c.max.Load()
		if int32(n) <= cur || c.max.CompareAndSwap(cur, int32(n)) {
			break
		}
	}
	c.mu.Lock()
	idx := len(c.calls)
	c.calls = append(c.calls, copied)
	c.mu.Unlock()

	if c.mode == "fifo" && idx == 0 {
		close(c.first)
		<-c.block
		c.inflight.Add(-1)
		return map[string]any{"success": true, "tabId": 10}, nil
	}
	if c.mode == "overlap" {
		<-c.block
		c.inflight.Add(-1)
		return map[string]any{"success": true, "tabId": 1}, nil
	}
	c.inflight.Add(-1)
	return map[string]any{"success": true, "tabId": 11}, nil
}

func TestSameSessionExecuteFIFO(t *testing.T) {
	be := &captureBE{first: make(chan struct{}), block: make(chan struct{}), mode: "fifo"}
	ex := NewExecutor(be, session.NewManager())

	done1 := make(chan error, 1)
	go func() {
		_, err := ex.Execute(context.Background(), "navigate", "s", map[string]any{"url": "https://a.com"})
		done1 <- err
	}()
	select {
	case <-be.first:
	case <-time.After(2 * time.Second):
		t.Fatal("first CallTool did not start")
	}

	done2 := make(chan error, 1)
	go func() {
		_, err := ex.Execute(context.Background(), "navigate", "s", map[string]any{"url": "https://b.com"})
		done2 <- err
	}()

	time.Sleep(50 * time.Millisecond)
	be.mu.Lock()
	n := len(be.calls)
	be.mu.Unlock()
	if n != 1 {
		t.Fatalf("second Execute entered CallTool early, calls=%d", n)
	}

	close(be.block)
	if err := <-done1; err != nil {
		t.Fatal(err)
	}
	if err := <-done2; err != nil {
		t.Fatal(err)
	}

	be.mu.Lock()
	defer be.mu.Unlock()
	if len(be.calls) != 2 {
		t.Fatalf("calls = %d", len(be.calls))
	}
	if be.calls[1]["_tabId"] != 10 {
		t.Fatalf("second Inject _tabId = %v, want 10 (first Update)", be.calls[1]["_tabId"])
	}
}

func TestDifferentSessionsOverlap(t *testing.T) {
	be := &captureBE{block: make(chan struct{}), mode: "overlap"}
	ex := NewExecutor(be, session.NewManager())

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = ex.Execute(context.Background(), "snapshot", "s1", nil)
	}()
	go func() {
		defer wg.Done()
		_, _ = ex.Execute(context.Background(), "snapshot", "s2", nil)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if be.max.Load() >= 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if be.max.Load() < 2 {
		t.Fatalf("in-flight max = %d, want 2 overlapping sessions", be.max.Load())
	}
	close(be.block)
	wg.Wait()
}

// 同 session 排队中的 Execute 响应 ctx 取消：立即返回、不进后端、不占 gate。
func TestQueuedExecuteCtxCancel(t *testing.T) {
	be := &captureBE{first: make(chan struct{}), block: make(chan struct{}), mode: "fifo"}
	ex := NewExecutor(be, session.NewManager())

	done1 := make(chan error, 1)
	go func() {
		_, err := ex.Execute(context.Background(), "navigate", "s", map[string]any{"url": "https://a.com"})
		done1 <- err
	}()
	select {
	case <-be.first:
	case <-time.After(2 * time.Second):
		t.Fatal("first CallTool did not start")
	}

	ctx2, cancel2 := context.WithCancel(context.Background())
	done2 := make(chan error, 1)
	go func() {
		_, err := ex.Execute(ctx2, "navigate", "s", map[string]any{"url": "https://b.com"})
		done2 <- err
	}()
	time.Sleep(50 * time.Millisecond) // 让第二个请求排进 FIFO
	cancel2()

	select {
	case err := <-done2:
		if err != context.Canceled {
			t.Fatalf("queued Execute err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled queued Execute did not return (still waiting on gate)")
	}

	// 被取消的请求不得进入后端。
	be.mu.Lock()
	n := len(be.calls)
	be.mu.Unlock()
	if n != 1 {
		t.Fatalf("canceled Execute reached CallTool, calls=%d", n)
	}

	// gate 未被取消的等待者占用：放行第一个后，第三个请求能正常执行。
	done3 := make(chan error, 1)
	go func() {
		_, err := ex.Execute(context.Background(), "snapshot", "s", nil)
		done3 <- err
	}()
	close(be.block)
	if err := <-done1; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done3:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("gate stuck: third Execute never ran after canceled waiter")
	}
}

func TestStaleTargetForgetsTab(t *testing.T) {
	be := &fakeBE{err: &ws.ToolError{
		Message: "session target tab 11 is no longer available",
		Code:    "stale_target",
		Details: map[string]any{"tabId": 11},
	}}
	sm := session.NewManager()
	sm.Update("s", "navigate", map[string]any{"success": true, "tabId": 10})
	sm.Update("s", "navigate", map[string]any{"success": true, "tabId": 11})
	ex := NewExecutor(be, sm)
	_, err := ex.Execute(context.Background(), "snapshot", "s", nil)
	te, ok := err.(*ws.ToolError)
	if !ok {
		t.Fatalf("err type %T %v", err, err)
	}
	if te.Code != "stale_target" {
		t.Fatalf("code = %q", te.Code)
	}
	if te.Details["session"] != "s" {
		t.Fatalf("details = %v", te.Details)
	}
	if te.Details["nextTabId"] != 10 {
		t.Fatalf("nextTabId = %v", te.Details["nextTabId"])
	}
	snap := sm.Snapshot("s")
	if snap.CurrentTabID != 10 || len(snap.TabIDs) != 1 || snap.TabIDs[0] != 10 {
		t.Fatalf("snap = %+v", snap)
	}
}

// details 缺 tabId（当前扩展不会这样发，兜底防线）：按协议 §3.4 注入语义 stale 的
// 只能是注入的 _tabId＝当前目标，回退清理它——而不是 ForgetTab(0) 空转，
// 否则 CurrentTabID 继续指着死 tab，nextTabId 把客户端循环引回故障点。
func TestStaleTargetMissingDetailsTabIdFallsBackToCurrentTab(t *testing.T) {
	be := &fakeBE{err: &ws.ToolError{
		Message: "session target tab 11 is no longer available",
		Code:    "stale_target",
		Details: map[string]any{"session": "s"}, // 无 tabId
	}}
	sm := session.NewManager()
	sm.Update("s", "navigate", map[string]any{"success": true, "tabId": 10})
	sm.Update("s", "navigate", map[string]any{"success": true, "tabId": 11})
	ex := NewExecutor(be, sm)
	_, err := ex.Execute(context.Background(), "snapshot", "s", nil)
	te, ok := err.(*ws.ToolError)
	if !ok || te.Code != "stale_target" {
		t.Fatalf("err = %v", err)
	}
	if te.Details["nextTabId"] != 10 {
		t.Fatalf("nextTabId = %v, want 10（不得引回死 tab 11）", te.Details["nextTabId"])
	}
	snap := sm.Snapshot("s")
	if snap.CurrentTabID != 10 || len(snap.TabIDs) != 1 || snap.TabIDs[0] != 10 {
		t.Fatalf("snap = %+v, want 死 tab 11 已清、回到 10", snap)
	}
}

// 死 tab 是 session 唯一目标且 details 整个缺失：清空当前目标，不写 nextTabId。
func TestStaleTargetMissingDetailsTabIdNoNext(t *testing.T) {
	be := &fakeBE{err: &ws.ToolError{
		Message: "session target tab 11 is no longer available",
		Code:    "stale_target",
	}} // Details 整个缺失
	sm := session.NewManager()
	sm.Update("s", "navigate", map[string]any{"success": true, "tabId": 11})
	ex := NewExecutor(be, sm)
	_, err := ex.Execute(context.Background(), "snapshot", "s", nil)
	te, ok := err.(*ws.ToolError)
	if !ok || te.Code != "stale_target" {
		t.Fatalf("err = %v", err)
	}
	if _, ok := te.Details["nextTabId"]; ok {
		t.Fatalf("nextTabId = %v, want 省略（没有存活的下一个）", te.Details["nextTabId"])
	}
	snap := sm.Snapshot("s")
	if snap.CurrentTabID != 0 {
		t.Fatalf("CurrentTabID = %d, want 0（死 tab 不得残留）", snap.CurrentTabID)
	}
}
