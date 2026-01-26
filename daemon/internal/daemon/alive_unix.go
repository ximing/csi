//go:build !windows

package daemon

import (
	"os"
	"syscall"
)

// PIDAlive 检查进程是否存活（signal 0 仅做存活探测，不产生实际信号）。
func PIDAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}
