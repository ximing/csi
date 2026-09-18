package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestPersistRoundTrip(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	m1 := NewManagerPersist(dir)
	m1.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(10)})

	m2 := NewManagerPersist(dir)
	args := m2.Inject("s", nil)
	if args["_tabId"] != 10 {
		t.Fatalf("_tabId = %v, want 10", args["_tabId"])
	}
	ids, ok := args["_tabIds"].([]int)
	if !ok || !reflect.DeepEqual(ids, []int{10}) {
		t.Fatalf("_tabIds = %v, want [10] (owned)", args["_tabIds"])
	}
	if args["_borrowed"] != false {
		t.Fatalf("_borrowed = %v, want false (owned)", args["_borrowed"])
	}
}

func TestPersistCorruptAndMissingStartEmpty(t *testing.T) {
	t.Parallel()
	missing := NewManagerPersist(t.TempDir())
	if names := missing.Names(); len(names) != 0 {
		t.Fatalf("missing sessions.json should start empty, names=%v", names)
	}

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "sessions.json"), []byte("not-json{"), 0o644); err != nil {
		t.Fatal(err)
	}
	corrupt := NewManagerPersist(dir)
	if names := corrupt.Names(); len(names) != 0 {
		t.Fatalf("corrupt sessions.json should start empty, names=%v", names)
	}
}

func TestPersistGroupTitleAndForgetTab(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	m1 := NewManagerPersist(dir)
	m1.Inject("s", map[string]any{"group_title": "my group"})
	m1.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(10)})
	m1.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(11)})
	m1.ForgetTab("s", 11)

	m2 := NewManagerPersist(dir)
	snap := m2.Snapshot("s")
	if snap.GroupTitle != "my group" {
		t.Fatalf("GroupTitle = %q", snap.GroupTitle)
	}
	if !reflect.DeepEqual(snap.TabIDs, []int{10}) || snap.CurrentTabID != 10 {
		t.Fatalf("after ForgetTab snap = %+v", snap)
	}
}

func TestPersistLoadTreatsAsFresh(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	m1 := NewManagerPersist(dir)
	m1.Inject("s", map[string]any{"group_title": "g"}) // 空 owned 集：若 lastAccess 为零值会被立刻 TTL

	m2 := NewManagerPersist(dir)
	m2.Inject("t", nil) // 触发 sweepLocked
	found := false
	for _, n := range m2.Names() {
		if n == "s" {
			found = true
		}
	}
	if !found {
		t.Fatal("加载后的 session 应视为刚访问，不得立刻 TTL（协议 §3.4）")
	}
}

func TestPersistFileShapeNoGate(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	m := NewManagerPersist(dir)
	m.Update("s", "navigate", map[string]any{"success": true, "tabId": float64(10)})
	m.Update("s", "find_tab", map[string]any{"success": true, "borrowed": true, "tabId": float64(99)})

	raw, err := os.ReadFile(filepath.Join(dir, "sessions.json"))
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("sessions.json not JSON object: %v\n%s", err, raw)
	}
	s, ok := decoded["s"]
	if !ok {
		t.Fatalf("missing session s: %s", raw)
	}
	for _, forbidden := range []string{"gate", "lastUsed", "lastAccess"} {
		if _, exists := s[forbidden]; exists {
			t.Fatalf("must not persist %s: %s", forbidden, raw)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "sessions.json.tmp")); !os.IsNotExist(err) {
		t.Fatal("atomic write left sessions.json.tmp")
	}
}
