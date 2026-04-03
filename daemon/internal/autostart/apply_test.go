package autostart

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestParseSub(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in      []string
		want    string
		wantErr bool
	}{
		{nil, "status", false},
		{[]string{}, "status", false},
		{[]string{"status"}, "status", false},
		{[]string{"on"}, "on", false},
		{[]string{"off"}, "off", false},
		{[]string{"foo"}, "", true},
		{[]string{"on", "extra"}, "", true},
	}
	for _, c := range cases {
		got, err := ParseSub(c.in)
		if c.wantErr {
			if err == nil {
				t.Fatalf("ParseSub(%q) err=nil", c.in)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Fatalf("ParseSub(%q)=%q,%v want %q", c.in, got, err, c.want)
		}
	}
}

func TestFormatStatusOffIsNotError(t *testing.T) {
	t.Parallel()
	got := FormatStatus(false, "/tmp/ai.csi.daemon.plist")
	if got != "off\n/tmp/ai.csi.daemon.plist\n" {
		t.Fatalf("got %q", got)
	}
	if strings.Contains(strings.ToLower(got), "error") {
		t.Fatalf("off must not look like an error: %q", got)
	}
	on := FormatStatus(true, "/tmp/ai.csi.daemon.plist")
	if on != "on\n/tmp/ai.csi.daemon.plist\n" {
		t.Fatalf("on = %q", on)
	}
}

func TestEnableDarwinWritesPlistAndBootstraps(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	exe := "/opt/csi/bin/csi"
	var cmds []string
	run := func(name string, args ...string) error {
		cmds = append(cmds, strings.Join(append([]string{name}, args...), " "))
		if name == "launchctl" && len(args) > 0 && args[0] == "bootout" {
			return os.ErrNotExist // on 必须忽略 bootout 失败
		}
		return nil
	}
	if err := enableDarwin(home, exe, 501, run); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(DarwinPlistPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), exe) || strings.Contains(string(body), "KeepAlive") {
		t.Fatalf("plist:\n%s", body)
	}
	joined := strings.Join(cmds, "\n")
	if !strings.Contains(joined, "launchctl bootout gui/501/ai.csi.daemon") {
		t.Fatalf("missing bootout: %q", cmds)
	}
	if !strings.Contains(joined, "launchctl bootstrap gui/501 "+DarwinPlistPath(home)) {
		t.Fatalf("missing bootstrap: %q", cmds)
	}
	if strings.Contains(joined, "serve") || strings.Contains(joined, " stop") {
		t.Fatalf("must not stop/serve: %q", cmds)
	}
}

func TestDisableDarwinRemovesPlist(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	plist := DarwinPlistPath(home)
	if err := os.MkdirAll(filepath.Dir(plist), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plist, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	run := func(name string, args ...string) error { return nil }
	if err := disableDarwin(home, 501, run); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(plist); !os.IsNotExist(err) {
		t.Fatalf("plist still there: %v", err)
	}
	// 再 off 一次：已经没了也是成功
	if err := disableDarwin(home, 501, run); err != nil {
		t.Fatal(err)
	}
}

func TestEnableLinuxWritesOneshotAndEnableNow(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	exe := "/home/ada/.csi/bin/csi"
	var cmds []string
	run := func(name string, args ...string) error {
		cmds = append(cmds, strings.Join(append([]string{name}, args...), " "))
		return nil
	}
	if err := enableLinux(home, exe, run); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(LinuxUnitPath(home))
	if err != nil {
		t.Fatal(err)
	}
	unit := string(body)
	if !strings.Contains(unit, "Type=oneshot") || strings.Contains(unit, "Restart=") {
		t.Fatalf("unit:\n%s", unit)
	}
	joined := strings.Join(cmds, "\n")
	if !strings.Contains(joined, "systemctl --user daemon-reload") {
		t.Fatalf("missing daemon-reload: %q", cmds)
	}
	if !strings.Contains(joined, "systemctl --user enable --now csi.service") {
		t.Fatalf("missing enable --now: %q", cmds)
	}
	if strings.Contains(joined, "linger") || strings.Contains(joined, "loginctl") {
		t.Fatalf("must not touch lingering: %q", cmds)
	}
}

func TestDisableLinuxDeletesUnitNoLinger(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	path := LinuxUnitPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	var cmds []string
	run := func(name string, args ...string) error {
		cmds = append(cmds, strings.Join(append([]string{name}, args...), " "))
		return nil
	}
	if err := disableLinux(home, run); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("unit still there: %v", err)
	}
	joined := strings.Join(cmds, "\n")
	if !strings.Contains(joined, "systemctl --user disable csi.service") {
		t.Fatalf("missing disable: %q", cmds)
	}
	if !strings.Contains(joined, "systemctl --user daemon-reload") {
		t.Fatalf("missing reload: %q", cmds)
	}
	if strings.Contains(joined, "linger") || strings.Contains(joined, " stop") {
		t.Fatalf("off must not stop/linger: %q", cmds)
	}
}

func TestEnabledFilePresence(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("windows Enabled 走注册表")
	}
	home := t.TempDir()
	on, err := Enabled(home)
	if err != nil {
		t.Fatal(err)
	}
	if on {
		t.Fatal("empty home should be off")
	}
}
