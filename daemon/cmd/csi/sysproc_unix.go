//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// detachProc 让子进程脱离父进程会话，父进程退出后 daemon 继续运行。
func detachProc(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// terminate 请求进程优雅退出（daemon 收到 SIGTERM 后自行清理）。
func terminate(proc *os.Process) error {
	return proc.Signal(syscall.SIGTERM)
}
