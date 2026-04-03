//go:build !windows

// linux CI 也能编译 Enable 的 windows 分支。
package autostart

func enableWindows(exe string) error { return ErrUnsupported }
func disableWindows() error          { return ErrUnsupported }
func windowsEnabled() (bool, error)  { return false, ErrUnsupported }
