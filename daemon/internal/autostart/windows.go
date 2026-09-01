//go:build windows

// Windows 登录自启：HKCU Run 值 CSI = `"<abs csi.exe>" start`。不需要管理员。
package autostart

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/registry"
)

func enableWindows(exe string) error {
	// 定时任务日志归口目录(<home>/.csi/logs):任务体里 cmd 的 >> 重定向
	// 只建文件不建目录,schtasks 也不代建,缺了目录每日更新的日志直接丢。
	home, err := homeDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(home, ".csi", "logs"), 0o755); err != nil {
		return err
	}
	k, _, err := registry.CreateKey(registry.CURRENT_USER, WindowsRunKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.SetStringValue(WindowsValueName, WindowsRunValue(exe)); err != nil {
		return err
	}
	// 每日更新任务:与登录自启同生同灭;/F 幂等覆盖同名任务
	return runCmd("schtasks", WindowsUpdateTaskCommand(exe, UpdateMinute())...)
}

func disableWindows() error {
	// 忽略失败:任务可能本来不存在
	_ = runCmd("schtasks", "/Delete", "/F", "/TN", WindowsUpdateTaskName)
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
