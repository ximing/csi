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
