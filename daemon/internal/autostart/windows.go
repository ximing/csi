//go:build windows

// Windows 登录自启：HKCU Run 值 CSI = `"<abs csi.exe>" start`。不需要管理员。
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
