// Package daemon 提供运行目录（~/.csi）相关能力：
// 目录初始化、pid 文件、identity.json、按天滚动的日志（见 logrotate.go）。
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
	"time"
)

// DefaultPort 默认监听端口（协议 §1）。
const DefaultPort = 10088

// Port 返回监听端口：CSI_PORT 环境变量 > config.json > 默认值。
func Port() int {
	if dir, err := RunDir(); err == nil {
		if rc, err := LoadConfig(dir); err == nil {
			return rc.Values.Port
		}
	}
	return DefaultPort
}

// RunDir 返回运行目录 ~/.csi；CSI_HOME 环境变量可覆盖（测试用）。
func RunDir() (string, error) {
	if v := os.Getenv("CSI_HOME"); v != "" {
		return v, nil
	}
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

// RemovePID 删除 pid 文件。pid > 0 时仅当文件内容等于 pid 才删——
// 自重启时序下（新进程已 WritePID、旧进程 defer 清理在后）旧进程
// 不会误删新进程的 pid 文件；读不到 / 不匹配则不删。
// pid <= 0 表示无条件清理（确认进程已死后的残留清理场景）。
func RemovePID(dir string, pid int) {
	if pid > 0 {
		cur, err := ReadPID(dir)
		if err != nil || cur != pid {
			return
		}
	}
	if err := os.Remove(pidFile(dir)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		fmt.Fprintf(os.Stderr, "remove pid file: %v\n", err)
	}
}

// PIDAlive 按平台实现，见 alive_unix.go / alive_windows.go。
