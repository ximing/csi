package tools

import (
	"context"
	"errors"
	"strings"
	"testing"

	"csi/daemon/internal/session"
)

type fakeBE struct {
	called string
	err    error
}

func (f *fakeBE) Name() string    { return "fake" }
func (f *fakeBE) Connected() bool { return f.err == nil }
func (f *fakeBE) CallTool(_ context.Context, name string, _ map[string]any) (any, error) {
	f.called = name
	if f.err != nil {
		return nil, f.err
	}
	return map[string]any{"ok": true}, nil
}

type fakeInv struct {
	ver          string
	tools        []string // nil = 未上报
	disconnected bool
}

func (f fakeInv) ExtensionVersion() string { return f.ver }
func (f fakeInv) ExtensionTools() []string { return f.tools }
func (f fakeInv) Connected() bool          { return !f.disconnected }

func TestMissingToolNotForwarded(t *testing.T) {
	be := &fakeBE{}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{ver: "0.3.0", tools: nil}
	_, err := ex.Execute(context.Background(), "wait", "s", nil)
	if err == nil || !strings.Contains(err.Error(), `does not implement "wait"`) {
		t.Fatalf("err=%v", err)
	}
	if !strings.Contains(err.Error(), "need ≥ 0.4.0") || !strings.Contains(err.Error(), "Chrome Web Store") {
		t.Fatalf("err=%v", err)
	}
	if be.called != "" {
		t.Fatalf("backend was called with %q", be.called)
	}
}

func TestAdvertisedToolsForwarded(t *testing.T) {
	be := &fakeBE{}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{ver: "0.4.0", tools: []string{"wait", "navigate"}}
	if _, err := ex.Execute(context.Background(), "wait", "s", nil); err != nil {
		t.Fatal(err)
	}
	if be.called != "wait" {
		t.Fatalf("called=%q", be.called)
	}
}

func TestAdvertisedMissingNotForwarded(t *testing.T) {
	be := &fakeBE{}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{ver: "0.4.0", tools: []string{"navigate"}}
	_, err := ex.Execute(context.Background(), "wait", "s", nil)
	if err == nil || !strings.Contains(err.Error(), `does not implement "wait"`) {
		t.Fatalf("err=%v", err)
	}
	if be.called != "" {
		t.Fatal("backend called")
	}
}

func TestUnknownToolUnchanged(t *testing.T) {
	ex := NewExecutor(&fakeBE{}, session.NewManager())
	_, err := ex.Execute(context.Background(), "not_a_tool", "s", nil)
	if err == nil || err.Error() != "unknown tool: not_a_tool" {
		t.Fatalf("err=%v", err)
	}
}

func TestDisconnectedWaitIsNotConnected(t *testing.T) {
	be := &fakeBE{err: errors.New("extension not connected")}
	ex := NewExecutor(be, session.NewManager())
	ex.Inventory = fakeInv{disconnected: true}
	_, err := ex.Execute(context.Background(), "wait", "s", nil)
	if err == nil || err.Error() != "extension not connected" {
		t.Fatalf("err=%v", err)
	}
	if strings.Contains(err.Error(), "does not implement") {
		t.Fatalf("upgrade wording leaked: %v", err)
	}
	if be.called != "wait" {
		t.Fatalf("backend not reached, called=%q", be.called)
	}
}
