//go:build windows

package daemon

import "os"

// PIDAlive 检查进程是否存活。
// Windows 上 FindProcess 会实际打开进程句柄，进程不存在时返回错误；
// 已退出但句柄尚未关闭的进程可能被误判为存活，属于可接受的近似。
func PIDAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	_ = proc.Release()
	return true
}
