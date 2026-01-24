// Package daemon 提供运行目录（~/.csi）相关能力：
// 目录初始化、pid 文件、identity.json、日志文件。
package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// DefaultPort 默认监听端口（协议 §1）。
const DefaultPort = 10088

// Port 返回监听端口：环境变量 CSI_PORT 覆盖默认值。
func Port() int {
	if v := os.Getenv("CSI_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n < 65536 {
			return n
		}
	}
	return DefaultPort
}

// RunDir 返回运行目录 ~/.csi。
func RunDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".csi"), nil
}

// EnsureRunDir 创建运行目录及 logs 子目录。
func EnsureRunDir() (string, error) {
	dir, err := RunDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// OpenLog 以追加方式打开 logs/daemon.log。
func OpenLog(dir string) (*os.File, error) {
	return os.OpenFile(filepath.Join(dir, "logs", "daemon.log"),
		os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
}

// identity identity.json 内容：首次启动生成的随机 id。
type identity struct {
	ID        string `json:"id"`
	CreatedAt string `json:"created_at"`
}

// EnsureIdentity 读取或首次生成 identity.json，返回实例 id。
func EnsureIdentity(dir string) (string, error) {
	path := filepath.Join(dir, "identity.json")
	if data, err := os.ReadFile(path); err == nil {
		var id identity
		if json.Unmarshal(data, &id) == nil && id.ID != "" {
			return id.ID, nil
		}
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	id := identity{
		ID:        hex.EncodeToString(b[:]),
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	data, _ := json.MarshalIndent(id, "", "  ")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", err
	}
	return id.ID, nil
}

// pidFile pid 文件路径。
func pidFile(dir string) string { return filepath.Join(dir, "daemon.pid") }

// WritePID 写入 daemon.pid。
func WritePID(dir string, pid int) error {
	return os.WriteFile(pidFile(dir), []byte(strconv.Itoa(pid)+"\n"), 0o644)
}

// ReadPID 读取 daemon.pid；文件不存在或内容非法时返回错误。
func ReadPID(dir string) (int, error) {
	data, err := os.ReadFile(pidFile(dir))
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf("bad pid file: %q", strings.TrimSpace(string(data)))
	}
	return pid, nil
}

// RemovePID 删除 pid 文件（不存在时忽略）。
func RemovePID(dir string) {
	if err := os.Remove(pidFile(dir)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		fmt.Fprintf(os.Stderr, "remove pid file: %v\n", err)
	}
}

// PIDAlive 检查进程是否存活。
func PIDAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// unix 上 signal 0 仅做存活探测
	return proc.Signal(syscall.Signal(0)) == nil
}
