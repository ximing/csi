package session

import (
	"reflect"
	"testing"
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

func TestCloseTabBorrowedReasonDoesNotClear(t *testing.T) {
	t.Parallel()
	m := NewManager()
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(10)})
	m.Update("s", "find_tab", map[string]any{"success": true, "borrowed": true, "tabId": float64(99)})
	m.Update("s", "close_tab", map[string]any{
		"success": true, "closed": false,
		"reason": "borrowed target is not owned by this session",
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
		"success": true, "closed": false, "reason": "tab already closed",
	})
	snap := m.Snapshot("s")
	if !reflect.DeepEqual(snap.TabIDs, []int{10}) || snap.CurrentTabID != 10 {
		t.Fatalf("already-closed should ForgetTab, snap = %+v", snap)
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
