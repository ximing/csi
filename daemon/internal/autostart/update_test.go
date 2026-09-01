package autostart

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDarwinUpdatePlist(t *testing.T) {
	t.Parallel()
	p := DarwinUpdatePlist("/Users/x/.csi/bin/csi", 37)
	for _, want := range []string{"ai.csi.update", "StartCalendarInterval", "<integer>4</integer>", "<integer>37</integer>", "/bin/sh", "start", "update"} {
		if !strings.Contains(p, want) {
			t.Errorf("plist 缺 %q", want)
		}
	}
	if strings.Contains(p, "KeepAlive") {
		t.Error("禁止 KeepAlive")
	}
	// 每日定时,不走 RunAtLoad;日志必须落 ~/.csi/logs/update.log
	if strings.Contains(p, "RunAtLoad") {
		t.Error("更新任务不该 RunAtLoad")
	}
	if !strings.Contains(p, "StandardOutPath") || !strings.Contains(p, "StandardErrorPath") {
		t.Errorf("缺日志归口:\n%s", p)
	}
	if !strings.Contains(p, "update.log") {
		t.Errorf("日志路径缺 update.log:\n%s", p)
	}
	// && 必须 XML 转义
	if strings.Contains(p, "&&") && !strings.Contains(p, "&amp;&amp;") {
		t.Errorf("&& 未转义:\n%s", p)
	}
}

func TestLinuxUpdateTimer(t *testing.T) {
	t.Parallel()
	timer, service := LinuxUpdateTimer("/home/x/.csi/bin/csi", 5)
	if !strings.Contains(timer, "OnCalendar=*-*-* 04:05:00") {
		t.Error(timer)
	}
	if !strings.Contains(timer, "Persistent=true") {
		t.Error("漏 Persistent")
	}
	if !strings.Contains(timer, "WantedBy=timers.target") {
		t.Error("漏 timers.target")
	}
	if !strings.Contains(service, "Type=oneshot") {
		t.Error(service)
	}
	if strings.Contains(service, "Restart=") {
		t.Error("禁止 Restart=")
	}
	// 语义:先幂等探活,再静默更新
	if !strings.Contains(service, `" start && `) || !strings.Contains(service, `update --quiet`) {
		t.Errorf("service 命令语义不对:\n%s", service)
	}
	// 分钟补零
	timer2, _ := LinuxUpdateTimer("/home/x/.csi/bin/csi", 59)
	if !strings.Contains(timer2, "OnCalendar=*-*-* 04:59:00") {
		t.Error(timer2)
	}
}

func TestWindowsUpdateTaskCommand(t *testing.T) {
	t.Parallel()
	exe := `C:\Users\ada\.csi\bin\csi.exe`
	args := WindowsUpdateTaskCommand(exe, 5)
	joined := strings.Join(args, " ")
	for _, want := range []string{"/Create", "/F", "/SC", "DAILY", "/ST", "04:05", "/TN", "CSI-Update", "/TR"} {
		if !strings.Contains(joined, want) {
			t.Errorf("schtasks 参数缺 %q: %q", want, joined)
		}
	}
	// /TR 值:cmd /c 包裹,start 探活 + update --quiet,日志落 %USERPROFILE%\.csi\logs\update.log
	tr := args[len(args)-1]
	for _, want := range []string{"cmd /c", exe, " start && ", "update --quiet", `%USERPROFILE%\.csi\logs\update.log`, "2>&1"} {
		if !strings.Contains(tr, want) {
			t.Errorf("/TR 缺 %q: %q", want, tr)
		}
	}
	if strings.Contains(joined, "serve") {
		t.Errorf("禁止拉起 serve: %q", joined)
	}
}

func TestUpdateMinuteStable(t *testing.T) {
	if UpdateMinute() != UpdateMinute() {
		t.Error("必须稳定")
	}
	if m := UpdateMinute(); m < 0 || m > 59 {
		t.Error("越界")
	}
}

func TestUpdateMinuteDerivedFromHome(t *testing.T) {
	orig := homeDir
	t.Cleanup(func() { homeDir = orig })
	homeDir = func() (string, error) { return "/home/tester", nil }
	sum := sha256.Sum256([]byte("/home/tester"))
	want := int(sum[0]) % 60
	if got := UpdateMinute(); got != want {
		t.Fatalf("UpdateMinute()=%d want %d", got, want)
	}
}

func TestEnableDarwinRegistersUpdateTask(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	exe := "/opt/csi/bin/csi"
	var cmds []string
	run := func(name string, args ...string) error {
		cmds = append(cmds, strings.Join(append([]string{name}, args...), " "))
		return nil
	}
	if err := enableDarwin(home, exe, 501, run); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(DarwinUpdatePlistPath(home))
	if err != nil {
		t.Fatal("更新 plist 未写入:", err)
	}
	if !strings.Contains(string(body), "ai.csi.update") || !strings.Contains(string(body), "StartCalendarInterval") {
		t.Fatalf("更新 plist 内容不对:\n%s", body)
	}
	joined := strings.Join(cmds, "\n")
	if !strings.Contains(joined, "launchctl bootstrap gui/501 "+DarwinUpdatePlistPath(home)) {
		t.Fatalf("缺更新任务 bootstrap: %q", cmds)
	}
}

func TestDisableDarwinRemovesUpdateTask(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	for _, p := range []string{DarwinPlistPath(home), DarwinUpdatePlistPath(home)} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var cmds []string
	run := func(name string, args ...string) error {
		cmds = append(cmds, strings.Join(append([]string{name}, args...), " "))
		return nil
	}
	if err := disableDarwin(home, 501, run); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(DarwinUpdatePlistPath(home)); !os.IsNotExist(err) {
		t.Fatalf("更新 plist 还在: %v", err)
	}
	joined := strings.Join(cmds, "\n")
	if !strings.Contains(joined, "launchctl bootout gui/501/ai.csi.update") {
		t.Fatalf("缺更新任务 bootout: %q", cmds)
	}
}

func TestEnableLinuxRegistersTimer(t *testing.T) {
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
	for _, p := range []string{LinuxUpdateTimerPath(home), LinuxUpdateServicePath(home)} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("缺 %s: %v", p, err)
		}
	}
	joined := strings.Join(cmds, "\n")
	if !strings.Contains(joined, "systemctl --user enable --now "+LinuxUpdateTimerName) {
		t.Fatalf("缺 timer enable: %q", cmds)
	}
}

func TestDisableLinuxRemovesTimer(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	for _, p := range []string{LinuxUnitPath(home), LinuxUpdateTimerPath(home), LinuxUpdateServicePath(home)} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var cmds []string
	run := func(name string, args ...string) error {
		cmds = append(cmds, strings.Join(append([]string{name}, args...), " "))
		return nil
	}
	if err := disableLinux(home, run); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{LinuxUpdateTimerPath(home), LinuxUpdateServicePath(home)} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s 还在: %v", p, err)
		}
	}
	joined := strings.Join(cmds, "\n")
	if !strings.Contains(joined, "systemctl --user disable "+LinuxUpdateTimerName) {
		t.Fatalf("缺 timer disable: %q", cmds)
	}
	// 对称:再 off 一次也成功
	if err := disableLinux(home, run); err != nil {
		t.Fatal(err)
	}
}
