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
	// 不修改调用方 map
	src := map[string]any{"url": "https://b.com"}
	m.Inject("s1", src)
	if _, ok := src["_session"]; ok {
		t.Fatal("Inject must not mutate caller's args map")
	}
}

func TestInjectOverridesUnderscoreFields(t *testing.T) {
	t.Parallel()
	m := NewManager()
	args := m.Inject("s1", map[string]any{"_session": "evil", "_tabId": 42})
	if args["_session"] != "s1" || args["_tabId"] != 0 {
		t.Fatalf("args = %v", args)
	}
}

func TestUpdateTabIdAndClose(t *testing.T) {
	t.Parallel()
	m := NewManager()
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(10)})
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(11)})
	snap := m.Snapshot("s")
	if !reflect.DeepEqual(snap.TabIDs, []int{10, 11}) || snap.LastTabID != 11 {
		t.Fatalf("snap = %+v", snap)
	}

	// 注入应携带最新状态
	args := m.Inject("s", nil)
	if args["_tabId"] != 11 {
		t.Fatalf("_tabId = %v", args["_tabId"])
	}

	// close_tab 移除当前标签，回退到上一个
	m.Update("s", "close_tab", map[string]any{"success": true, "closed": true})
	snap = m.Snapshot("s")
	if !reflect.DeepEqual(snap.TabIDs, []int{10}) || snap.LastTabID != 10 {
		t.Fatalf("after close_tab snap = %+v", snap)
	}

	// close_session 清空
	m.Update("s", "close_session", map[string]any{"success": true, "closed": true})
	snap = m.Snapshot("s")
	if len(snap.TabIDs) != 0 || snap.LastTabID != 0 {
		t.Fatalf("after close_session snap = %+v", snap)
	}
}

func TestUpdateBorrowedTabNotAdopted(t *testing.T) {
	t.Parallel()
	m := NewManager()
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(10)})

	// find_tab 借用用户前台标签：borrowed:true 时不得收编
	m.Update("s", "find_tab", map[string]any{"success": true, "borrowed": true, "tabId": float64(99)})
	snap := m.Snapshot("s")
	if !reflect.DeepEqual(snap.TabIDs, []int{10}) || snap.LastTabID != 10 {
		t.Fatalf("borrowed tab must not be adopted, snap = %+v", snap)
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
