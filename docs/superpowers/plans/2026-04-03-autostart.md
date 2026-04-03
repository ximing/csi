# 0.5.0 开机自启 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地规格 0.5.0：登录时幂等跑 `csi start`，安装器默认打开，CLI `csi autostart on|off|status`；`csi stop` 之后直到下次登录或下次 `start` 保持停止。

**Architecture:** 零协议。login 单元只执行 `csi start`（幂等、自行 detach `serve`），**禁止** launchd/systemd KeepAlive 托管 `serve`。plist / systemd unit / Windows Run 值由纯函数生成，单测钉字符串；真正调 `launchctl` / `systemctl` / 注册表的 apply 走可注入的 `runCmd`，单测用 `t.TempDir()` + fake runner，**不准**对本机执行 `csi autostart on/off`。绝对路径一律 `os.Executable()`（CLI 注入），安装器拷完二进制再 `autostart on`。

**Tech Stack:** 现有 Go daemon CLI。Windows 注册表用 `golang.org/x/sys/windows/registry`（已在 `go.mod`）+ build tag。不加依赖、不改扩展、不改 `docs/protocol.md`。

**Spec:** `docs/superpowers/specs/2026-03-30-agent-reliability-design.md` 阶段 B（已确认）。**本计划只做 0.5.0。** 0.6 iframe/对话框/下载禁止顺手做。

## Global Constraints

- 零协议：禁止改 `docs/protocol.md`。四处工具清单保持 20 个不动。
- 登录跑 `csi start`（幂等）。**永远不要** launchd/systemd KeepAlive（或 `Restart=`）去托管 `serve`。
- `csi stop` 之后保持停止，直到下次登录或下次 `start`。崩溃不自动拉起。接受。
- CLI：`csi autostart`（同 status）、`csi autostart status`、`csi autostart on`、`csi autostart off`。`off` 只撤自启，不停正在跑的 daemon。
- `status` 打印 `on` 或 `off` 再加一行单元路径。非 0 退出码只用于真正的系统错误；off 不是错误。
- macOS：`~/Library/LaunchAgents/ai.csi.daemon.plist`，`ProgramArguments=[abs exe, start]`，`RunAtLoad=true`，无 KeepAlive。`on`：写文件，`bootout` 旧的（忽略失败）再 `bootstrap`。`off`：bootout + 删文件。
- Linux：`~/.config/systemd/user/csi.service`，`Type=oneshot`，`ExecStart=<abs exe> start`，`WantedBy=default.target`。`on`：写 unit，`daemon-reload`，`enable --now`。`off`：`disable` + 删 unit + `daemon-reload`。不碰 lingering。
- Windows：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 值名 `CSI` = `"<abs csi.exe>" start`。不需要管理员。`off` 删这个值。
- 绝对路径取 `os.Executable()`。生成函数不自己调它，由 CLI 传入，方便单测钉字符串。
- **不要**加 `~/.csi/autostart.disabled`。**不要**加 options 页开关。**不要**改扩展。
- **不要**在单测或实现过程中对本机执行 `csi autostart on/off`（会写 `~/Library/LaunchAgents` / systemd user / HKCU Run）。断言只打生成字符串 + temp dir。
- 安全边界不动：只绑 `127.0.0.1`，v1 无鉴权。
- daemon 改完：`cd daemon && go test ./... && go vet ./...`。本计划不应改 extension；若误碰：`cd extension && npm run typecheck && npm run build`。
- 版本号留到最后一个 Task 一次性改 0.5.0。中间 commit 保持 0.4.0。不要打 tag。
- 安装器双端 parity 是硬约束（`scripts/CLAUDE.md`）：`--no-autostart` / `-NoAutostart` / `CSI_NO_AUTOSTART=1` 两端同时出现。默认开；失败只警告，不让整个安装失败。
- 技能：agent 重启后仍自己 `csi start`；**禁止** agent 自己执行 `autostart on/off`（与 stop/restart 同档）。

## File map

| 文件 | 职责 |
|---|---|
| `daemon/internal/autostart/generate.go` | 纯函数：Darwin plist / Linux unit / Windows Run 值 / 各平台路径。无副作用 |
| `daemon/internal/autostart/generate_test.go` | 字符串断言：有 `start`、无 KeepAlive / `Restart=` / `serve`、路径正确 |
| `daemon/internal/autostart/apply.go` | `ParseSub` / `FormatStatus` / `Enable` / `Disable` / `Enabled` / `UnitPath`；darwin+linux apply（可注入 `runCmd`） |
| `daemon/internal/autostart/apply_test.go` | temp dir 写文件 + fake runner 记录 launchctl/systemctl 参数；断言不碰 lingering、不 `stop` |
| `daemon/internal/autostart/windows.go` | `//go:build windows` 写/删 HKCU Run |
| `daemon/internal/autostart/nowin.go` | `//go:build !windows` 给 `enableWindows` 一个 stub，linux CI 能编译 `Enable` 的 windows 分支 |
| `daemon/cmd/csi/autostart.go` | `cmdAutostart`：`UserHomeDir` + `os.Executable()` 交给 apply |
| `daemon/cmd/csi/main.go` | 注册 `autostart` 子命令 + usage |
| `scripts/install.sh` / `scripts/install.ps1` | 默认 `autostart on`；`--no-autostart` / `-NoAutostart` / `CSI_NO_AUTOSTART=1`；失败 warn 不 die |
| `scripts/CLAUDE.md` | 双端旗标表补上 autostart |
| `README.md` / `README.zh-CN.md` | 安装器旗标段落 |
| `skills/csi/SKILL.md` | 重启后仍 `csi start`；不要自己 on/off |
| `skills/csi/references/operations.md` | 同上 + 用户抱怨时告诉他们 `autostart status` |
| `daemon/internal/version/version.go` 等 | 最后一个任务才改 0.5.0 |

Linux 规格示例写的是 `ExecStart=%h/.csi/bin/csi start`。实现**不要**写死 `%h/.csi/bin/csi`：装完再 `on` 时 `os.Executable()` 就是那个路径，开发机上的别的位置也不会指错。必要的 `[Unit]` 段（`Description=CSI daemon`）规格没写，加上，否则 systemd 不认。

---

### Task 1: 纯函数生成 plist / unit / Run 值

**Files:**
- Create: `daemon/internal/autostart/generate.go`
- Create: `daemon/internal/autostart/generate_test.go`

**Interfaces:**
- Produces（后续任务必须用这些名字，禁止另起）：
  - `const DarwinLabel = "ai.csi.daemon"`
  - `const LinuxServiceName = "csi.service"`
  - `const WindowsValueName = "CSI"`
  - `const WindowsRunKey = `Software\Microsoft\Windows\CurrentVersion\Run``
  - `const WindowsRunPath = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\CSI``
  - `func DarwinPlistPath(home string) string` → `home/Library/LaunchAgents/ai.csi.daemon.plist`
  - `func LinuxUnitPath(home string) string` → `home/.config/systemd/user/csi.service`
  - `func DarwinPlist(exe string) string`
  - `func LinuxUnit(exe string) string`
  - `func WindowsRunValue(exe string) string` → `"<exe>" start`（exe 原样包一层双引号）
  - `func xmlEscape(s string) string`（仅 generate.go 内部使用也可，但测试要覆盖 `&` `<`）

- [ ] **Step 1: 写失败测试**

`daemon/internal/autostart/generate_test.go`：

```go
package autostart

import (
	"strings"
	"testing"
)

func TestDarwinPlistPath(t *testing.T) {
	t.Parallel()
	got := DarwinPlistPath("/Users/ada")
	want := "/Users/ada/Library/LaunchAgents/ai.csi.daemon.plist"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestLinuxUnitPath(t *testing.T) {
	t.Parallel()
	got := LinuxUnitPath("/home/ada")
	want := "/home/ada/.config/systemd/user/csi.service"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestDarwinPlistIsStartNotServeNoKeepAlive(t *testing.T) {
	t.Parallel()
	exe := "/Users/ada/.csi/bin/csi"
	plist := DarwinPlist(exe)
	if !strings.Contains(plist, "<string>ai.csi.daemon</string>") {
		t.Fatalf("missing Label:\n%s", plist)
	}
	if !strings.Contains(plist, "<string>"+exe+"</string>") {
		t.Fatalf("missing exe:\n%s", plist)
	}
	if !strings.Contains(plist, "<string>start</string>") {
		t.Fatalf("missing start arg:\n%s", plist)
	}
	if strings.Contains(plist, "KeepAlive") {
		t.Fatalf("KeepAlive must be absent:\n%s", plist)
	}
	if strings.Contains(plist, "serve") {
		t.Fatalf("must not launch serve:\n%s", plist)
	}
	if !strings.Contains(plist, "<key>RunAtLoad</key>") || !strings.Contains(plist, "<true/>") {
		t.Fatalf("RunAtLoad true missing:\n%s", plist)
	}
}

func TestDarwinPlistEscapesXML(t *testing.T) {
	t.Parallel()
	plist := DarwinPlist(`/tmp/a&b<c>.bin`)
	if strings.Contains(plist, `/tmp/a&b<c>.bin`) {
		t.Fatalf("unescaped path:\n%s", plist)
	}
	if !strings.Contains(plist, `/tmp/a&amp;b&lt;c&gt;.bin`) {
		t.Fatalf("expected xml escape:\n%s", plist)
	}
}

func TestLinuxUnitIsOneshotStartNoRestart(t *testing.T) {
	t.Parallel()
	exe := "/home/ada/.csi/bin/csi"
	unit := LinuxUnit(exe)
	for _, want := range []string{
		"Type=oneshot",
		`ExecStart="` + exe + `" start`,
		"WantedBy=default.target",
		"[Install]",
		"[Service]",
		"[Unit]",
	} {
		if !strings.Contains(unit, want) {
			t.Fatalf("missing %q:\n%s", want, unit)
		}
	}
	for _, forbid := range []string{"KeepAlive", "Restart=", "lingering", "enable-linger", " serve"} {
		if strings.Contains(unit, forbid) {
			t.Fatalf("forbid %q:\n%s", forbid, unit)
		}
	}
}

func TestWindowsRunValueQuotesExe(t *testing.T) {
	t.Parallel()
	got := WindowsRunValue(`C:\Users\ada\.csi\bin\csi.exe`)
	want := `"C:\Users\ada\.csi\bin\csi.exe" start`
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	if strings.Contains(got, "serve") {
		t.Fatalf("must not launch serve: %q", got)
	}
}

func TestWindowsRunPathConstant(t *testing.T) {
	t.Parallel()
	if WindowsRunPath != `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\CSI` {
		t.Fatalf("WindowsRunPath = %q", WindowsRunPath)
	}
	if WindowsValueName != "CSI" || WindowsRunKey != `Software\Microsoft\Windows\CurrentVersion\Run` {
		t.Fatalf("windows names = %q %q", WindowsValueName, WindowsRunKey)
	}
}
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd daemon && go test ./internal/autostart -count=1
```

Expected: FAIL，包不存在或 `DarwinPlist` undefined。

- [ ] **Step 3: 最小实现**

`daemon/internal/autostart/generate.go`：

```go
package autostart

import (
	"path/filepath"
	"strings"
)

const (
	DarwinLabel       = "ai.csi.daemon"
	LinuxServiceName  = "csi.service"
	WindowsValueName  = "CSI"
	WindowsRunKey     = `Software\Microsoft\Windows\CurrentVersion\Run`
	WindowsRunPath    = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\CSI`
	darwinPlistName   = "ai.csi.daemon.plist"
)

func DarwinPlistPath(home string) string {
	return filepath.Join(home, "Library", "LaunchAgents", darwinPlistName)
}

func LinuxUnitPath(home string) string {
	return filepath.Join(home, ".config", "systemd", "user", LinuxServiceName)
}

func xmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	return s
}

func DarwinPlist(exe string) string {
	esc := xmlEscape(exe)
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + DarwinLabel + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>` + esc + `</string>
		<string>start</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
</dict>
</plist>
`
}

func LinuxUnit(exe string) string {
	return `[Unit]
Description=CSI daemon

[Service]
Type=oneshot
ExecStart="` + exe + `" start

[Install]
WantedBy=default.target
`
}

func WindowsRunValue(exe string) string {
	return `"` + exe + `" start`
}
```

plist 用 tab 缩进即可（测试用 `Contains`，不比整文件）。**不要**输出 `KeepAlive` 键，哪怕 `false`。

- [ ] **Step 4: 再跑测试**

```bash
cd daemon && go test ./internal/autostart -count=1 && go vet ./internal/autostart
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/autostart/generate.go daemon/internal/autostart/generate_test.go
git commit -m "autostart 生成函数：plist/unit/Run 值纯字符串，单测钉住 KeepAlive 不准出现"
```

---

### Task 2: darwin / linux apply + Windows 注册表（build tag）

**Files:**
- Create: `daemon/internal/autostart/apply.go`
- Create: `daemon/internal/autostart/apply_test.go`
- Create: `daemon/internal/autostart/windows.go`
- Create: `daemon/internal/autostart/nowin.go`
- Modify: `daemon/CLAUDE.md` 结构列表加一行 `internal/autostart/`

**Interfaces:**
- Consumes: Task 1 的生成函数与路径函数。
- Produces：
  - `var ErrUnsupported = errors.New("autostart: unsupported OS")`
  - `type runFunc func(name string, args ...string) error`
  - `var runCmd runFunc`（默认 `defaultRun`；测试可替换。生产路径走这个，**测试禁止**在不替换时调用 `Enable`/`Disable`）
  - `func ParseSub(args []string) (string, error)` — `[]` → `"status"`；`"status"|"on"|"off"` 原样返回；多一个参数或未知词返回 error
  - `func FormatStatus(on bool, path string) string` — `"on\n<path>\n"` 或 `"off\n<path>\n"`
  - `func UnitPath(home string) string` — 按 `runtime.GOOS` 选 DarwinPlistPath / LinuxUnitPath / WindowsRunPath
  - `func Enabled(home string) (bool, error)` — darwin/linux：单元文件是否存在（不存在 → `false, nil`）；windows：Run 值是否存在
  - `func Enable(home, exe string) error`
  - `func Disable(home string) error`
  - `func enableDarwin(home, exe string, uid int, run runFunc) error`（测试直接调）
  - `func enableLinux(home, exe string, run runFunc) error`
  - `func disableDarwin(home string, uid int, run runFunc) error`
  - `func disableLinux(home string, run runFunc) error`
  - `func enableWindows(exe string) error` / `func disableWindows() error` / `func windowsEnabled() (bool, error)`

darwin `on` 命令（uid 例 501，plist=`<home>/Library/LaunchAgents/ai.csi.daemon.plist`）：

```
launchctl bootout gui/501/ai.csi.daemon     # 忽略错误
launchctl bootstrap gui/501 <plist>
```

linux `on`：

```
systemctl --user daemon-reload
systemctl --user enable --now csi.service
```

linux `off`：

```
systemctl --user disable csi.service        # 忽略错误
# 删 unit 文件（已不存在则忽略）
systemctl --user daemon-reload
```

darwin `off`：`bootout`（忽略错误）+ 删 plist（已不存在则成功）。

**禁止**：`loginctl`、`enable-linger`、`KeepAlive`、`Restart=`、对 daemon 发 `stop` / `kill`、`ExecStart=... serve`。

- [ ] **Step 1: 写失败测试（CLI 解析 + apply，先不碰本机目录）**

`daemon/internal/autostart/apply_test.go`：

```go
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
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd daemon && go test ./internal/autostart -count=1
```

Expected: FAIL（`ParseSub` / `enableDarwin` undefined）。

- [ ] **Step 3: 实现 apply.go**

```go
package autostart

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

var ErrUnsupported = errors.New("autostart: unsupported OS")

type runFunc func(name string, args ...string) error

func defaultRun(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v (%s)", strings.Join(append([]string{name}, args...), " "), err, bytesTrim(out))
	}
	return nil
}

func bytesTrim(b []byte) string { return strings.TrimSpace(string(b)) }

var runCmd runFunc = defaultRun

func ParseSub(args []string) (string, error) {
	if len(args) == 0 {
		return "status", nil
	}
	if len(args) > 1 {
		return "", fmt.Errorf("autostart: extra arguments")
	}
	switch args[0] {
	case "status", "on", "off":
		return args[0], nil
	default:
		return "", fmt.Errorf("unknown autostart command: %s", args[0])
	}
}

func FormatStatus(on bool, path string) string {
	state := "off"
	if on {
		state = "on"
	}
	return state + "\n" + path + "\n"
}

func UnitPath(home string) string {
	switch runtime.GOOS {
	case "darwin":
		return DarwinPlistPath(home)
	case "linux":
		return LinuxUnitPath(home)
	case "windows":
		return WindowsRunPath
	default:
		return ""
	}
}

func Enabled(home string) (bool, error) {
	switch runtime.GOOS {
	case "darwin", "linux":
		_, err := os.Stat(UnitPath(home))
		if err == nil {
			return true, nil
		}
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	case "windows":
		return windowsEnabled()
	default:
		return false, ErrUnsupported
	}
}

func Enable(home, exe string) error {
	switch runtime.GOOS {
	case "darwin":
		return enableDarwin(home, exe, os.Getuid(), runCmd)
	case "linux":
		return enableLinux(home, exe, runCmd)
	case "windows":
		return enableWindows(exe)
	default:
		return ErrUnsupported
	}
}

func Disable(home string) error {
	switch runtime.GOOS {
	case "darwin":
		return disableDarwin(home, os.Getuid(), runCmd)
	case "linux":
		return disableLinux(home, runCmd)
	case "windows":
		return disableWindows()
	default:
		return ErrUnsupported
	}
}

func enableDarwin(home, exe string, uid int, run runFunc) error {
	path := DarwinPlistPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(DarwinPlist(exe)), 0o644); err != nil {
		return err
	}
	domain := "gui/" + strconv.Itoa(uid)
	_ = run("launchctl", "bootout", domain+"/"+DarwinLabel) // 忽略：可能本来没加载
	return run("launchctl", "bootstrap", domain, path)
}

func disableDarwin(home string, uid int, run runFunc) error {
	domain := "gui/" + strconv.Itoa(uid)
	_ = run("launchctl", "bootout", domain+"/"+DarwinLabel)
	err := os.Remove(DarwinPlistPath(home))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func enableLinux(home, exe string, run runFunc) error {
	path := LinuxUnitPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(LinuxUnit(exe)), 0o644); err != nil {
		return err
	}
	if err := run("systemctl", "--user", "daemon-reload"); err != nil {
		return err
	}
	return run("systemctl", "--user", "enable", "--now", LinuxServiceName)
}

func disableLinux(home string, run runFunc) error {
	_ = run("systemctl", "--user", "disable", LinuxServiceName)
	err := os.Remove(LinuxUnitPath(home))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return run("systemctl", "--user", "daemon-reload")
}
```

把 `bytesTrim` 内联进 `defaultRun` 也可以，不要多一个无用导出。

- [ ] **Step 4: Windows 注册表 + linux stub**

`daemon/internal/autostart/windows.go`：

```go
//go:build windows

package autostart

import (
	"golang.org/x/sys/windows/registry"
)

func enableWindows(exe string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, WindowsRunKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(WindowsValueName, WindowsRunValue(exe))
}

func disableWindows() error {
	k, err := registry.OpenKey(registry.CURRENT_USER, WindowsRunKey, registry.SET_VALUE)
	if err != nil {
		if err == registry.ErrNotExist {
			return nil
		}
		return err
	}
	defer k.Close()
	err = k.DeleteValue(WindowsValueName)
	if err == registry.ErrNotExist {
		return nil
	}
	return err
}

func windowsEnabled() (bool, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, WindowsRunKey, registry.QUERY_VALUE)
	if err != nil {
		if err == registry.ErrNotExist {
			return false, nil
		}
		return false, err
	}
	defer k.Close()
	_, _, err = k.GetStringValue(WindowsValueName)
	if err == registry.ErrNotExist {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
```

`daemon/internal/autostart/nowin.go`：

```go
//go:build !windows

package autostart

func enableWindows(exe string) error { return ErrUnsupported }
func disableWindows() error          { return ErrUnsupported }
func windowsEnabled() (bool, error)  { return false, ErrUnsupported }
```

`windows.go` **不要**在 linux 测试里调用 `Enable()`（那会走 linux 的 systemctl）。字符串已经在 Task 1 钉死。CI 用交叉编译证明它能过编译器。

`daemon/CLAUDE.md` 结构列表 `cmd/csi/` 那一行下面加：

```
- `internal/autostart/` — 登录自启（plist/systemd/HKCU Run）；生成函数纯字符串，apply 禁止 KeepAlive
```

- [ ] **Step 5: 跑测试 + windows 交叉编译 + vet**

```bash
cd daemon && go test ./... && go vet ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null ./cmd/csi
```

Expected: 测试 PASS（`cmd/csi` 此时还没有 `autostart` 子命令，build 仍应成功）。`GOOS=windows go build` PASS，证明 `windows.go` 在 linux CI 能编译。

**禁止**：跑 `go test` 时替换 `runCmd` 后对真实 `$HOME` 调 `Enable`。temp dir 以外的 LaunchAgents / systemd user / HKCU 本任务碰了就是失败。

- [ ] **Step 6: 提交**

```bash
git add daemon/internal/autostart daemon/CLAUDE.md
git commit -m "登录只调 start：darwin/linux/windows 自启，没 KeepAlive"
```

---

### Task 3: CLI `csi autostart`

**Files:**
- Create: `daemon/cmd/csi/autostart.go`
- Modify: `daemon/cmd/csi/main.go`（switch + usage + 文件头注释）
- Create: `daemon/cmd/csi/autostart_test.go`（必须 `t.Parallel()`——同包 `TestRestartIntegration` 要求其他测试都 parallel）

**Interfaces:**
- Consumes: `autostart.ParseSub` / `FormatStatus` / `Enabled` / `Enable` / `Disable` / `UnitPath`
- Produces: `func cmdAutostart() error`
- `os.Executable()` 取绝对路径；`os.UserHomeDir()` 取 home（**不要**用 `CSI_HOME`——登录单元必须落在真实 `~/Library` / `~/.config`，不是测试目录）
- `on` / `off` 成功后也打印 `FormatStatus`，方便安装器/人看
- 未知子命令走 `ParseSub` 的 error → `main` 里 `os.Exit(1)`（已有逻辑）。off 返回 nil

- [ ] **Step 1: 写失败测试**

把 `usage()` 的字符串抽成 `usageText()` 是本任务允许的小拆，测试钉那份文本。先写测试文件（此时 `usageText` 还不存在，会红）：

`daemon/cmd/csi/autostart_test.go`：

```go
package main

import (
	"strings"
	"testing"

	"csi/daemon/internal/autostart"
)

func TestAutostartParseDefaultIsStatus(t *testing.T) {
	t.Parallel()
	sub, err := autostart.ParseSub(nil)
	if err != nil || sub != "status" {
		t.Fatalf("default = %q %v", sub, err)
	}
}

func TestUsageListsAutostart(t *testing.T) {
	t.Parallel()
	usage := usageText()
	if !strings.Contains(usage, "autostart") {
		t.Fatalf("usage missing autostart:\n%s", usage)
	}
	if !strings.Contains(usage, "status | on | off") {
		t.Fatalf("usage missing autostart subcommands:\n%s", usage)
	}
}
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd daemon && go test ./cmd/csi -run TestUsageListsAutostart -count=1
```

Expected: FAIL，`usageText` undefined。

- [ ] **Step 3: 实现**

`main.go` 的 `usage()` 改成：

```go
func usage() {
	fmt.Fprint(os.Stderr, usageText())
}

func usageText() string {
	return `usage: csi <command>

commands:
  serve           run daemon in foreground
  start           start daemon in background (no-op if already running)
  stop [--force]  stop background daemon
  restart         restart background daemon
  status          show daemon status
  autostart       login autostart (status | on | off; default status)
  version         print version
  mcp             run MCP server over stdio (forwards to the local daemon)

environment:
  CSI_PORT  listen port (default 10088)
`
}
```

`main` switch 增加：

```go
	case "autostart":
		err = cmdAutostart()
```

文件头注释的子命令列表加上 `autostart`。

`daemon/cmd/csi/autostart.go`：

```go
package main

import (
	"fmt"
	"os"

	"csi/daemon/internal/autostart"
)

func cmdAutostart() error {
	sub, err := autostart.ParseSub(os.Args[2:])
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	switch sub {
	case "status":
		on, err := autostart.Enabled(home)
		if err != nil {
			return err
		}
		fmt.Print(autostart.FormatStatus(on, autostart.UnitPath(home)))
		return nil
	case "on":
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		if err := autostart.Enable(home, exe); err != nil {
			return err
		}
		fmt.Print(autostart.FormatStatus(true, autostart.UnitPath(home)))
		return nil
	case "off":
		if err := autostart.Disable(home); err != nil {
			return err
		}
		fmt.Print(autostart.FormatStatus(false, autostart.UnitPath(home)))
		return nil
	default:
		return fmt.Errorf("unknown autostart command: %s", sub)
	}
}
```

**本任务验证 CLI 时**：`go test` / `go build` 可以；`go run . autostart status` 可以（只读，off 也是 0）。**不要**跑 `go run . autostart on` 或 `off`。

- [ ] **Step 4: 跑测试**

```bash
cd daemon && go test ./... && go vet ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null ./cmd/csi
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add daemon/cmd/csi/main.go daemon/cmd/csi/autostart.go daemon/cmd/csi/autostart_test.go
git commit -m "csi autostart on/off/status，off 不是错误"
```

---

### Task 4: 安装器默认打开，失败只警告

**Files:**
- Modify: `scripts/install.sh`
- Modify: `scripts/install.ps1`
- Modify: `scripts/CLAUDE.md`
- Modify: `README.md` 旗标那一段（约 L82）
- Modify: `README.zh-CN.md` 对应段落

**Interfaces:**
- 双端同一组：`--no-autostart` / `-NoAutostart` / 环境变量 `CSI_NO_AUTOSTART=1`
- 默认：**开**。daemon 二进制就位之后、`csi start` 之前或之后都可以（start 幂等）。本计划约定 **先 autostart 再 start**：macOS bootstrap / linux `enable --now` 会顺带 start 一次，再 `csi start` 是 no-op。
- 失败：`warn`，`exit 0` 继续。不要 `die`。
- 再跑一遍安装器会再次 `on`（覆盖旧 plist）。帮助文本写明：用户若手动 `off` 过，再跑安装器会被重新打开。0.5 **不加** `~/.csi/autostart.disabled`。
- 步骤编号 4 → 5：`[1/5] daemon` `[2/5] extension` `[3/5] skills` `[4/5] Login autostart` `[5/5] Starting daemon`
- 安装器里调的是刚拷好的 `"$BIN_PATH" autostart on` / `& $BinPath autostart on`，不要对本机已经在 PATH 里的别的 `csi` 下手。

- [ ] **Step 1: 改 `install.sh`**

1. `show_help` Options 增加（放在 `--no-start` 后面）：

```
  --no-autostart     Don't register login autostart (csi start at login).
                     Re-running the installer re-enables autostart even if
                     you previously ran csi autostart off.
```

Environment 增加：

```
  CSI_NO_AUTOSTART   Set to 1 to skip login autostart.
```

What it does 在「4. Start the daemon」之前插入：

```
  4. Register login autostart (skip with --no-autostart / CSI_NO_AUTOSTART=1)
  5. Start the daemon (idempotent)
```

Usage 注释头也可以加一行 `--no-autostart` 例子。

2. 变量与解析：

```bash
NO_START=0
NO_AUTOSTART=0
NO_SKILL=0
NO_EXT=0
ASSUME_YES=0
[ "${CSI_NO_EXTENSION:-}" = "1" ] && NO_EXT=1
[ "${CSI_NO_AUTOSTART:-}" = "1" ] && NO_AUTOSTART=1
```

`case` 增加：

```bash
    --no-autostart)    NO_AUTOSTART=1; shift ;;
```

3. 把所有 `[N/4]` 改成 `[N/5]`（daemon=1, extension=2, skills=3）。在「# ---------- 4. start daemon ----------」之前插入：

```bash
# ---------- 4. login autostart ----------

if [ "$NO_AUTOSTART" -eq 1 ]; then
  step "[4/5] Login autostart — skipped (--no-autostart)"
  info "enable later with:  $BIN_PATH autostart on"
else
  step "[4/5] Login autostart"
  if "$BIN_PATH" autostart on; then
    ok "login autostart registered"
  else
    warn "failed to register login autostart — after reboot run: $BIN_PATH autostart on"
  fi
fi
```

start 那段改成 `[5/5]`。`set -e` 下 `if "$BIN_PATH" autostart on; then` 失败不会退出。

- [ ] **Step 2: 改 `install.ps1`（parity）**

`param` 增加 `[switch]$NoAutostart`（放在 `$NoStart` 旁）。

与 `CSI_NO_EXTENSION` 同一处：

```powershell
if (-not $NoAutostart -and $env:CSI_NO_AUTOSTART -eq '1') { $NoAutostart = $true }
```

Help Options（`-NoStart` 后）：

```
  -NoAutostart   Don't register login autostart (csi start at login).
                 Re-running the installer re-enables autostart even if
                 you previously ran csi autostart off.
```

Environment：

```
  `$env:CSI_NO_AUTOSTART   Set to 1 to skip login autostart.
```

What it does 同步 5 步。所有 `[N/4]` → 前三步改 `[N/5]`。

在 start 之前：

```powershell
    # ---------- 4. login autostart ----------

    if ($NoAutostart) {
        Step '[4/5] Login autostart - skipped (-NoAutostart)'
        Info "enable later with:  $BinPath autostart on"
    } else {
        Step '[4/5] Login autostart'
        $autoOk = $false
        try {
            & $BinPath autostart on
            $autoOk = ($LASTEXITCODE -eq 0)
        } catch {
            $autoOk = $false
        }
        if ($autoOk) {
            Ok 'login autostart registered'
        } else {
            Warn "failed to register login autostart - after reboot run: $BinPath autostart on"
        }
    }
```

start 改为 `[5/5]`。**不要**因为 autostart 失败 `Die`。

- [ ] **Step 3: `scripts/CLAUDE.md` 旗标表**

把「双端 parity 是硬约束」那句扩成包含新旗标（原列表不要删）：

```
- **双端 parity 是硬约束**：`install.sh` 与 `install.ps1` 必须支持同一组旗标（`--no-extension`/`-NoExtension`、`--no-start`/`-NoStart`、`--no-autostart`/`-NoAutostart`、`--no-skill`/`-NoSkill`、`--agents`/`-Agents`、`-y`/`-Yes`）与同一组环境变量（`CSI_VERSION`、`CSI_AGENTS`、`CSI_NO_EXTENSION`、`CSI_NO_AUTOSTART`）。加功能时两端同时改。商店用户用 `--no-extension`（或 `CSI_NO_EXTENSION=1`）跳过解压版 zip。
```

「安装结束默认启动 daemon」那句改成：

```
- 安装结束默认注册登录自启并启动 daemon；`csi start` 幂等。`--no-autostart` / `-NoAutostart` / `CSI_NO_AUTOSTART=1` 跳过自启。`autostart on` 失败只警告，不让整个安装失败。
```

- [ ] **Step 4: README 旗标段落**

`README.md` L82 那句「Both installers accept the same flags:」在 `--no-start` 后插入：

```
`--no-autostart` / `-NoAutostart` (don't register login autostart; also `CSI_NO_AUTOSTART=1`; re-running the installer turns autostart back on even after `csi autostart off`)
```

`README.zh-CN.md` 对应：

```
`--no-autostart` / `-NoAutostart`（不注册登录自启；也可用 `CSI_NO_AUTOSTART=1`；再跑一次安装器会把曾经 `csi autostart off` 过的自启重新打开）
```

- [ ] **Step 5: 双端帮助文本自检（grep，不是对本机 on）**

```bash
grep -n -- '--no-autostart' scripts/install.sh
grep -n -- '-NoAutostart' scripts/install.ps1
grep -n CSI_NO_AUTOSTART scripts/install.sh scripts/install.ps1
grep -n 'autostart off' scripts/install.sh scripts/install.ps1
```

Expected: 两端帮助和环境变量都出现；都提到再跑安装器会重新打开。两端都没有 `die`/`Die` 包着 `autostart on`。

- [ ] **Step 6: 提交**

```bash
git add scripts/install.sh scripts/install.ps1 scripts/CLAUDE.md README.md README.zh-CN.md
git commit -m "安装器默认打开自启，--no-autostart 才跳过，失败只警告"
```

---

### Task 5: 技能 — agent 仍自己 `csi start`，不准开关自启

**Files:**
- Modify: `skills/csi/SKILL.md`「If a tool call fails (daemon not ready)」整节
- Modify: `skills/csi/references/operations.md` Recovery 第 1 条 + Do NOT do automatically

**Interfaces:**
- Agent 冷启动/重启后**仍然**自己跑 `csi start`（幂等）。不要改成「假设自启一定成功所以先问用户」。
- 用户抱怨每次开机都要等一轮 → 告诉他们 `csi autostart status`，必要时让**用户**跑 `csi autostart on`。
- **不要**让 agent 自己执行 `autostart on` / `autostart off`。和 `stop` / `restart` / `uninstall` 同一档。
- 写明：再跑安装器会把曾经 off 过的自启重新打开。

- [ ] **Step 1: 改 `SKILL.md`**

把现在这两段：

```
This is also the expected state after a computer reboot: the installer does not register any login autostart, so the daemon stays down until something starts it. Just start it and move on — no need to tell the user anything is wrong.
```

以及结尾的 `Never run stop / restart / uninstall automatically` 整节，换成：

```
After a reboot the installer-registered login autostart should already have run `csi start`. If a tool call still cannot reach the daemon, start it yourself — don't ask the user. `start` is idempotent.

Never run `stop` / `restart` / `uninstall` / `autostart on` / `autostart off` automatically — those change the running daemon or the machine's login behavior. If the user complains they wait a round after every boot, tell them to run `csi autostart status` (prints `on` or `off` plus the unit path) and, if they agree, `csi autostart on`. Re-running the installer also turns autostart back on, even after a manual `off`.
```

`csi start` 的 macOS/Linux/Windows 命令块保留，仍是失败后的第一动作。

- [ ] **Step 2: 改 `operations.md`**

Recovery 第 1 条现在这句删掉：

```
Note this is the expected state after a computer reboot — there is no login autostart, so the daemon waits for something to start it.
```

换成：

```
After a reboot, login autostart (if registered) should already have run `csi start`. If the daemon is still down, start it yourself — `start` is idempotent. If the user says this happens after every boot, tell them to run `csi autostart status` and, only if they ask, `csi autostart on`. Never run `autostart on`/`off` yourself. Re-running the installer re-enables autostart even after a manual `off`.
```

「Do NOT do automatically」第一段改成：

```
Never run `stop` / `restart` / `uninstall` / `autostart on` / `autostart off` on your own. `stop`/`restart`/`uninstall` kill the running daemon and any in-flight work. `autostart on`/`off` change whether the daemon comes back at login — that needs the user's OK. If a hard restart is genuinely needed, ask the user to run `csi restart` by hand. If they want login autostart, ask them to run `csi autostart on`.
```

- [ ] **Step 3: 扫一遍不要教错**

```bash
git grep -n 'no login autostart\|does not register any login\|autostart on' -- skills README.md README.zh-CN.md
```

Expected: skills 里不再说「没有登录自启」；`autostart on` 只出现在「让用户跑 / 不要自己跑」。

- [ ] **Step 4: 提交**

```bash
git add skills/csi/SKILL.md skills/csi/references/operations.md
git commit -m "技能还是自己 csi start；别替用户开关开机自启"
```

---

### Task 6: 版本号 0.5.0（最后才改，不要打 tag）

**Files:**
- Modify: `daemon/internal/version/version.go` → `"0.5.0"`
- Modify: `daemon/internal/server/server_test.go` 两处 `"0.4.0"` 断言（`daemonVersion` / `status.version`）→ `"0.5.0"`
- Modify: `extension/manifest.json`、`extension/package.json`、`package.json`、`site/package.json`
- Modify: `site/src/i18n/zh.ts` / `en.ts` 的 `footer.version` → `v0.5.0`
- Modify: `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`.codex-plugin/plugin.json`、`.cursor-plugin/plugin.json`、`.kimi-plugin/plugin.json`
- Modify: `skills/csi/SKILL.md` 与 `skills/csi-e2e/SKILL.md` 的 `metadata.version`
- Modify: `store/UPLOAD.md` 里 `csi-extension-v0.4.0.zip` → `csi-extension-v0.5.0.zip`（两处）
- `extension/package-lock.json` / `site/package-lock.json` 顶部 name/version 跟着改（与 0.4.0 时相同：手改 lock 里那两处，或对应目录 `npm install --package-lock-only`）
- 可选：`README.md` / `README.zh-CN.md` 路线图 0.5 那行改成已做（不要删 0.6）

用 `git grep -n '0.4.0'` 扫一遍。下面这些 **不要改**（历史/引入版本，不是本发版号）：

- `docs/protocol.md`（零协议；`wait` 自 0.4.0 引入仍写 0.4.0）
- `docs/superpowers/specs/2026-03-30-agent-reliability-design.md` 与旧 plans
- `daemon/internal/tools/tools.go` 的 `toolSince`（`wait`/`scroll`/`hover` 仍是 0.4.0）
- `daemon/internal/tools/tools_test.go` 里 `need ≥ 0.4.0`
- hub_test 里当输入用的 `"extensionVersion": "0.4.0"`（那是握手夹具，不是 daemon 版本）

不要打 git tag。

- [ ] **Step 1: 改版本字符串**

全部改完后：

```bash
cd daemon && go test ./... && go vet ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /dev/null ./cmd/csi
```

Expected: PASS。`server_test` 若还钉 0.4.0 会红，一起改掉。本任务不要改 extension 源码；只改 `manifest.json` / `package.json` 版本的话不必 `npm run build`。

- [ ] **Step 2: 手测清单（实现者自己的机器；本计划的 agent 不要替他执行 on/off）**

自动化已经覆盖生成字符串与 temp-dir apply。下面是规格 B.测试 的人工项，写在这里给实现者，**不要**在 CI / 本 worktree 会话里对宿主机 `csi autostart on/off`：

1. 把刚 build 的二进制放到一个 **用完就删的隔离用户** 或临时 macOS 用户，再 `autostart on` → 注销/登录 → `curl -s http://127.0.0.1:10088/status` 通。
2. `autostart off` → 再登录 → `/status` 不通；`csi start` 仍能拉起来。
3. `csi start` 后 `csi stop` → 进程不再被 launchd/systemd 拉起（没有 KeepAlive）。
4. Windows：HKCU Run 出现 `CSI`，值为带引号的 `csi.exe` + ` start`。
5. `csi autostart status` 在 off 时打印 `off` 和单元路径，退出码 0。

- [ ] **Step 3: 提交**

```bash
git add daemon/internal/version/version.go daemon/internal/server/server_test.go \
  extension/manifest.json extension/package.json extension/package-lock.json \
  package.json site/package.json site/package-lock.json site/src/i18n \
  .claude-plugin .codex-plugin .cursor-plugin .kimi-plugin \
  skills/csi/SKILL.md skills/csi-e2e/SKILL.md store/UPLOAD.md README.md README.zh-CN.md
git commit -m "版本 0.5.0：开机还在"
```

---

## Spec coverage（自检）

| 规格条款 | 任务 |
|---|---|
| 登录调 `csi start`，不用 KeepAlive 托管 `serve` | Task 1–2 |
| `stop` 后保持停止；崩溃不拉起 | Task 2（无 KeepAlive / `Restart=`）+ Task 6 手测 3 |
| CLI `autostart` / `status` / `on` / `off` | Task 2 ParseSub + Task 3 |
| status 打印 on/off + 路径；off 退出 0 | Task 2 `FormatStatus` + Task 3 |
| macOS plist Label/RunAtLoad/bootout+bootstrap | Task 1–2 |
| Linux oneshot + enable --now；off disable+删+reload；不碰 lingering | Task 1–2 |
| Windows HKCU Run `CSI`；无管理员 | Task 1–2 `windows.go` |
| 绝对路径 `os.Executable()` | Task 3 CLI 注入 |
| 安装器 `--no-autostart` / `-NoAutostart` / `CSI_NO_AUTOSTART=1`；默认开；失败 warn | Task 4 |
| 再跑安装器会重新 on；无 `autostart.disabled` | Task 4 帮助文本 |
| 技能仍 `csi start`；agent 不准 on/off | Task 5 |
| Go 字符串断言；Windows build tag；linux CI 只编译 | Task 1–3 |
| 版本 0.5.0 | Task 6 |
| 零协议 / 不做 0.6 / 不做 options 开关 | Global Constraints |

## 不要做

- 不要改 `docs/protocol.md`。
- 不要给 launchd/systemd 加 KeepAlive / `Restart=` / lingering。
- 不要加 `~/.csi/autostart.disabled`。
- 不要加 options 页「开机自启」开关。
- 不要改扩展工具、registry、MCP、`validTools`。
- 不要在测试或实现过程中对本机执行 `csi autostart on/off`。
- 不要在本计划里打 `v0.5.0` tag。
- 不要做 0.6 iframe / handle_dialog / downloads。
