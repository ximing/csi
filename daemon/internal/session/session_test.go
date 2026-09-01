package session

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestInjectDefaults(t *testing.T) {
	t.Parallel()
	m := NewManager()
	args := m.Inject("s1", map[string]any{"url": "https://a.com"})
	if args["_session"] != "s1" || args["_tabId"] != 0 {
		t.Fatalf("args = %v", args)
	}
	if ids, ok := args["_tabIds"].([]int); !ok || len(ids) != 0 {
		t.Fatalf("_tabIds = %v", args["_tabIds"])
	}
	if args["_borrowed"] != false {
		t.Fatalf("_borrowed = %v", args["_borrowed"])
	}
	src := map[string]any{"url": "https://b.com"}
	m.Inject("s1", src)
	if _, ok := src["_session"]; ok {
		t.Fatal("Inject must not mutate caller's args map")
	}
}

func TestInjectOverridesUnderscoreFields(t *testing.T) {
	t.Parallel()
	m := NewManager()
	args := m.Inject("s1", map[string]any{"_session": "evil", "_tabId": 42, "_borrowed": true})
	if args["_session"] != "s1" || args["_tabId"] != 0 || args["_borrowed"] != false {
		t.Fatalf("args = %v", args)
	}
}

func TestUpdateTabIdAndClose(t *testing.T) {
	t.Parallel()
	m := NewManager()
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(10)})
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(11)})
	snap := m.Snapshot("s")
	if !reflect.DeepEqual(snap.TabIDs, []int{10, 11}) || snap.CurrentTabID != 11 || snap.Borrowed {
		t.Fatalf("snap = %+v", snap)
	}

	args := m.Inject("s", nil)
	if args["_tabId"] != 11 || args["_borrowed"] != false {
		t.Fatalf("_tabId/_borrowed = %v %v", args["_tabId"], args["_borrowed"])
	}

	m.Update("s", "close_tab", map[string]any{"success": true, "closed": true})
	snap = m.Snapshot("s")
	if !reflect.DeepEqual(snap.TabIDs, []int{10}) || snap.CurrentTabID != 10 {
		t.Fatalf("after close_tab snap = %+v", snap)
	}

	m.Update("s", "close_session", map[string]any{"success": true, "closed": true})
	snap = m.Snapshot("s")
	if len(snap.TabIDs) != 0 || snap.CurrentTabID != 0 || snap.Borrowed {
		t.Fatalf("after close_session snap = %+v", snap)
	}
}

func TestUpdateBorrowedBecomesCurrentNotOwned(t *testing.T) {
	t.Parallel()
	m := NewManager()
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(10)})

	m.Update("s", "find_tab", map[string]any{"success": true, "borrowed": true, "tabId": float64(99)})
	snap := m.Snapshot("s")
	if !reflect.DeepEqual(snap.TabIDs, []int{10}) || snap.CurrentTabID != 99 || !snap.Borrowed {
		t.Fatalf("borrowed must be current but not owned, snap = %+v", snap)
	}
	args := m.Inject("s", nil)
	if args["_tabId"] != 99 || args["_borrowed"] != true {
		t.Fatalf("inject after borrow: %v", args)
	}
}

func TestUpdateBorrowedTrueOnOwnedIdIgnored(t *testing.T) {
	t.Parallel()
	m := NewManager()
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(10)})
	m.Update("s", "find_tab", map[string]any{"success": true, "borrowed": true, "tabId": float64(10)})
	snap := m.Snapshot("s")
	if !reflect.DeepEqual(snap.TabIDs, []int{10}) || snap.CurrentTabID != 10 || snap.Borrowed {
		t.Fatalf("owned id must stay owned, snap = %+v", snap)
	}
}

func TestNavigateDoesNotAdoptBorrowedTab(t *testing.T) {
	t.Parallel()
	m := NewManager()
	m.Update("s", "find_tab", map[string]any{"success": true, "borrowed": true, "tabId": float64(99)})
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(99)})
	snap := m.Snapshot("s")
	if containsInt(snap.TabIDs, 99) || snap.CurrentTabID != 99 || !snap.Borrowed {
		t.Fatalf("navigate must not adopt borrowed tab, snap = %+v", snap)
	}
}

func TestCloseTabNotOwnedDoesNotClear(t *testing.T) {
	t.Parallel()
	m := NewManager()
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(10)})
	m.Update("s", "find_tab", map[string]any{"success": true, "borrowed": true, "tabId": float64(99)})
	m.Update("s", "close_tab", map[string]any{
		"success": true, "closed": false,
		"code": "not_owned", "reason": "borrowed target is not owned by this session",
	})
	snap := m.Snapshot("s")
	if snap.CurrentTabID != 99 || !snap.Borrowed || !reflect.DeepEqual(snap.TabIDs, []int{10}) {
		t.Fatalf("reject-close must not change session, snap = %+v", snap)
	}
}

func TestCloseTabAlreadyClosedForgets(t *testing.T) {
	t.Parallel()
	m := NewManager()
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(10)})
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(11)})
	m.Update("s", "close_tab", map[string]any{
		"success": true, "closed": false, "code": "already_closed",
	})
	snap := m.Snapshot("s")
	if !reflect.DeepEqual(snap.TabIDs, []int{10}) || snap.CurrentTabID != 10 {
		t.Fatalf("already-closed should ForgetTab, snap = %+v", snap)
	}
}

// close_failed：关闭动作失败、tab 仍开着，绝不能把它移出 owned 集（协议 §3.4）。
func TestCloseTabCloseFailedDoesNotForget(t *testing.T) {
	t.Parallel()
	m := NewManager()
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(10)})
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(11)})
	m.Update("s", "close_tab", map[string]any{
		"success": true, "closed": false, "code": "close_failed",
	})
	snap := m.Snapshot("s")
	if !reflect.DeepEqual(snap.TabIDs, []int{10, 11}) || snap.CurrentTabID != 11 {
		t.Fatalf("close_failed must not ForgetTab, snap = %+v", snap)
	}
}

func TestForgetTab(t *testing.T) {
	t.Parallel()
	m := NewManager()
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(10)})
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(11)})
	next := m.ForgetTab("s", 11)
	if next != 10 {
		t.Fatalf("next = %d", next)
	}
	snap := m.Snapshot("s")
	if !reflect.DeepEqual(snap.TabIDs, []int{10}) || snap.CurrentTabID != 10 || snap.Borrowed {
		t.Fatalf("snap = %+v", snap)
	}
	if m.ForgetTab("s", 10) != 0 {
		t.Fatal("want next 0")
	}
}

func TestGroupTitleRecorded(t *testing.T) {
	t.Parallel()
	m := NewManager()
	m.Inject("s", map[string]any{"group_title": "my group"})
	if got := m.Snapshot("s").GroupTitle; got != "my group" {
		t.Fatalf("GroupTitle = %q", got)
	}
}

func TestNames(t *testing.T) {
	t.Parallel()
	m := NewManager()
	m.Inject("b", nil)
	m.Inject("a", nil)
	if got := m.Names(); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("Names = %v", got)
	}
}

func TestSessionEvictIdleTTL(t *testing.T) {
	m := NewManager()
	now := time.Now()
	m.Now = func() time.Time { return now }
	m.Inject("old", map[string]any{})
	now = now.Add(25 * time.Hour)     // 超 IdleTTL
	m.Inject("new", map[string]any{}) // 触发惰性清扫
	for _, n := range m.Names() {
		if n == "old" {
			t.Fatal("闲置超 24h 的 session 未被回收")
		}
	}
}

func TestSessionEvictLRU(t *testing.T) {
	m := NewManager()
	for i := 0; i < MaxSessions; i++ {
		m.Inject(fmt.Sprintf("s%03d", i), map[string]any{})
	}
	m.Inject("s000", map[string]any{}) // 刷新 s000，使它不是最久未用
	m.Inject("overflow", map[string]any{})
	names := m.Names()
	if len(names) > MaxSessions {
		t.Fatalf("session 数 %d 超上限", len(names))
	}
	found := false
	for _, n := range names {
		if n == "s000" {
			found = true
		}
	}
	if !found {
		t.Fatal("LRU 误杀了刚访问的 s000")
	}
	for _, n := range names {
		if n == "s001" {
			t.Fatal("最久未用的 s001 应被淘汰")
		}
	}
}

func TestSessionEvictSkipsBusy(t *testing.T) {
	m := NewManager()
	now := time.Now()
	m.Now = func() time.Time { return now }
	release, err := m.Acquire(context.Background(), "busy")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	now = now.Add(25 * time.Hour)
	m.Inject("trigger", map[string]any{})
	found := false
	for _, n := range m.Names() {
		if n == "busy" {
			found = true
		}
	}
	if !found {
		t.Fatal("持有锁的 session 不能被回收")
	}
}

func TestFifoOrder(t *testing.T) {
	t.Parallel()
	f := &fifo{}
	order := make(chan int, 3)
	f.Lock()
	started := make(chan struct{})
	go func() {
		close(started)
		f.Lock()
		order <- 1
		f.Unlock()
	}()
	<-started
	// 等 waiter 入队。fifo.Lock 在 Unlock 之前会阻塞；给一点时间入 wait 切片。
	for i := 0; i < 100; i++ {
		f.mu.Lock()
		n := len(f.wait)
		f.mu.Unlock()
		if n == 1 {
			break
		}
	}
	go func() {
		f.Lock()
		order <- 2
		f.Unlock()
	}()
	for i := 0; i < 100; i++ {
		f.mu.Lock()
		n := len(f.wait)
		f.mu.Unlock()
		if n == 2 {
			break
		}
	}
	f.Unlock()
	if <-order != 1 || <-order != 2 {
		t.Fatal("fifo woke waiters out of order")
	}
}

// 取消的等待者：不再占用 gate、从队列摘除，且不阻塞/不吞掉后续授权。
func TestFifoLockCtxCancel(t *testing.T) {
	t.Parallel()
	f := &fifo{}
	f.Lock()

	ctx1, cancel1 := context.WithCancel(context.Background())
	err1 := make(chan error, 1)
	go func() { err1 <- f.LockCtx(ctx1) }()

	// 等 waiter1 入队后再排 waiter2。
	waitLen := func(want int) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			f.mu.Lock()
			n := len(f.wait)
			f.mu.Unlock()
			if n == want {
				return
			}
			time.Sleep(time.Millisecond)
		}
		t.Fatalf("wait queue never reached len %d", want)
	}
	waitLen(1)

	got2 := make(chan struct{})
	go func() {
		if err := f.LockCtx(context.Background()); err != nil {
			t.Errorf("waiter2 LockCtx: %v", err)
		}
		close(got2)
		f.Unlock()
	}()
	waitLen(2)

	cancel1()
	select {
	case err := <-err1:
		if err != context.Canceled {
			t.Fatalf("waiter1 err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled waiter1 did not return")
	}
	waitLen(1) // waiter1 已摘除，队列只剩 waiter2

	// 授权必须落到 waiter2，不被已取消的 waiter1 吞掉。
	f.Unlock()
	select {
	case <-got2:
	case <-time.After(2 * time.Second):
		t.Fatal("grant leaked: waiter2 never acquired after waiter1 canceled")
	}

	// gate 最终空闲，可再获取。
	if err := f.LockCtx(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.Unlock()
}

// 取消与授权竞态：ctx 已取消但 Unlock 已把授权发出时，授权优先（返回 nil），
// 调用方照常 Unlock，授权不泄漏。
func TestFifoLockCtxCancelAfterGrant(t *testing.T) {
	t.Parallel()
	for i := 0; i < 200; i++ {
		f := &fifo{}
		f.Lock()
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- f.LockCtx(ctx) }()
		// 等 waiter 入队。
		for {
			f.mu.Lock()
			n := len(f.wait)
			f.mu.Unlock()
			if n == 1 {
				break
			}
		}
		f.Unlock() // 授权与 cancel 竞态
		cancel()
		if err := <-done; err == nil {
			f.Unlock() // 授权优先路径：收下了就必须放掉
		}
		// 无论哪条路径赢，gate 最终都必须空闲可再取。
		if err := f.LockCtx(context.Background()); err != nil {
			t.Fatalf("iter %d: gate stuck after cancel/grant race", i)
		}
		f.Unlock()
	}
}
