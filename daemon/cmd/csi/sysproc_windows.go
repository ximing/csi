//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP：daemon 脱离控制台独立运行。
const detachCreationFlags = 0x00000008 | 0x00000200

// detachProc 让子进程脱离当前控制台，父进程退出后 daemon 继续运行。
func detachProc(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags:    detachCreationFlags,
		NoInheritHandles: true,
	}
}

// terminate Windows 没有 SIGTERM 语义，直接结束进程。
func terminate(proc *os.Process) error {
	return proc.Kill()
}
