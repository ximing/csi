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

// ErrUnsupported 当前 GOOS 没有登录自启实现。
var ErrUnsupported = errors.New("autostart: unsupported OS")

type runFunc func(name string, args ...string) error

func defaultRun(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v (%s)", strings.Join(append([]string{name}, args...), " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

var runCmd runFunc = defaultRun

// ParseSub 解析 autostart 子命令：空 → status；只接受 status|on|off。
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

// FormatStatus 打印 on|off 再加一行单元路径。off 不是错误。
func FormatStatus(on bool, path string) string {
	state := "off"
	if on {
		state = "on"
	}
	return state + "\n" + path + "\n"
}

// UnitPath 按 GOOS 返回 plist / unit / HKCU Run 路径。
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

// Enabled 看单元文件（或 Windows Run 值）是否存在；不存在 → false, nil。
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

// Enable 写登录单元并加载。exe 必须是绝对路径（调用方用 os.Executable）。
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

// Disable 撤自启，不停正在跑的 daemon。
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
