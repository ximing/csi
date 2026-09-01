// 登录自启单元的纯字符串生成：darwin plist / systemd unit / Windows Run 值。
// 登录只跑 `csi start`（幂等），禁止 KeepAlive / Restart= 托管 serve。
package autostart

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	DarwinLabel      = "ai.csi.daemon"
	LinuxServiceName = "csi.service"
	WindowsValueName = "CSI"
	WindowsRunKey    = `Software\Microsoft\Windows\CurrentVersion\Run`
	WindowsRunPath   = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\CSI`
	darwinPlistName  = "ai.csi.daemon.plist"

	// 每日更新定时任务:csi start 幂等探活,然后 csi update --quiet。
	// 失败只写日志,不打扰用户;禁用 KeepAlive / Restart=,与登录单元同约束。
	DarwinUpdateLabel      = "ai.csi.update"
	LinuxUpdateTimerName   = "csi-update.timer"
	LinuxUpdateServiceName = "csi-update.service"
	WindowsUpdateTaskName  = "CSI-Update"
	darwinUpdatePlistName  = "ai.csi.update.plist"
)

// homeDir 是 os.UserHomeDir 的注入点,测试可换。
var homeDir = os.UserHomeDir

// UpdateMinute 派生每日更新的分钟(0-59)。与 spec C3 的随机 jitter
// 有意偏离:用 sha256(home) 取稳定值,负载分散目标等价,且同机同值
// 更利于排查与测试。
func UpdateMinute() int {
	home, err := homeDir()
	if err != nil {
		home = ""
	}
	sum := sha256.Sum256([]byte(home))
	return int(sum[0]) % 60
}

// updateLogPath 定时任务 stdout/stderr 归口(spec:失败只写日志)。
func updateLogPath() string {
	home, err := homeDir()
	if err != nil {
		home = "~"
	}
	return filepath.Join(home, ".csi", "logs", "update.log")
}

func DarwinUpdatePlistPath(home string) string {
	return filepath.Join(home, "Library", "LaunchAgents", darwinUpdatePlistName)
}

func LinuxUpdateTimerPath(home string) string {
	return filepath.Join(home, ".config", "systemd", "user", LinuxUpdateTimerName)
}

func LinuxUpdateServicePath(home string) string {
	return filepath.Join(home, ".config", "systemd", "user", LinuxUpdateServiceName)
}

// updateShellCmd 定时任务执行体:先幂等探活,失败则不更新。
func updateShellCmd(exe string) string {
	return `"` + exe + `" start && "` + exe + `" update --quiet`
}

// DarwinUpdatePlist 每日 04:minute 触发一次;不写 RunAtLoad(那是登录单元的语义)。
func DarwinUpdatePlist(exe string, minute int) string {
	log := xmlEscape(updateLogPath())
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + DarwinUpdateLabel + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>-c</string>
		<string>` + xmlEscape(updateShellCmd(exe)) + `</string>
	</array>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>4</integer>
		<key>Minute</key>
		<integer>` + fmt.Sprintf("%d", minute) + `</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>` + log + `</string>
	<key>StandardErrorPath</key>
	<string>` + log + `</string>
</dict>
</plist>
`
}

// LinuxUpdateTimer 返回 timer 与配对的 oneshot service。
// stdout/stderr 默认进 journal,满足"失败只写日志"。
// user timer 在用户未登录期间不触发(与现有 user service 同限制,可接受)。
func LinuxUpdateTimer(exe string, minute int) (timer, service string) {
	timer = `[Unit]
Description=CSI daily update

[Timer]
OnCalendar=*-*-* 04:` + fmt.Sprintf("%02d", minute) + `:00
Persistent=true

[Install]
WantedBy=timers.target
`
	service = `[Unit]
Description=CSI daily update

[Service]
Type=oneshot
ExecStart=/bin/sh -c '` + updateShellCmd(exe) + `'
`
	return timer, service
}

// WindowsUpdateTaskCommand 返回 schtasks /Create 的参数切片。
// /TR 引号嵌套:最外层一对双引号交给 cmd /c(cmd 会剥掉外层、保留内层),
// 所以 exe 两侧的引号在 cmd 语义里实际是内层引号——值里写成
// cmd /c ""<exe>" start && "<exe>" update --quiet >> "..." 2>&1"
// exec.Command 不经 shell,该字符串原样交给 schtasks 解析。
// stdout/stderr 重定向到 %USERPROFILE%\.csi\logs\update.log(cmd 会展开环境变量)。
func WindowsUpdateTaskCommand(exe string, minute int) []string {
	tr := `cmd /c ""` + exe + `" start && "` + exe + `" update --quiet >> "%USERPROFILE%\.csi\logs\update.log" 2>&1"`
	return []string{
		"/Create", "/F",
		"/SC", "DAILY",
		"/ST", fmt.Sprintf("04:%02d", minute),
		"/TN", WindowsUpdateTaskName,
		"/TR", tr,
	}
}

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
