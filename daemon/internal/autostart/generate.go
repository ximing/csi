// 登录自启单元的纯字符串生成：darwin plist / systemd unit / Windows Run 值。
// 登录只跑 `csi start`（幂等），禁止 KeepAlive / Restart= 托管 serve。
package autostart

import (
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
