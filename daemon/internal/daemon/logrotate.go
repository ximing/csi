// 日志滚动：logs/daemon-2006-01-02.log 按本地日期滚动，保留天数可配置（默认 3 天），
// 用于事后排查异常（跨天运行也不会把单个日志文件撑大）。
package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	logPrefix = "daemon-"
	logExt    = ".log"
)

// logPath 某一天的日志文件路径（dir 为 logs 目录）。
func logPath(dir string, t time.Time) string {
	return filepath.Join(dir, logPrefix+t.Format("2006-01-02")+logExt)
}

// OpenLogFile 以追加方式打开当天的日志文件。供 start 命令作为子进程的
// stdout/stderr；跨天滚动由子进程 serve 内的 DailyLog 负责。
func OpenLogFile(dir string) (*os.File, error) {
	return os.OpenFile(logPath(filepath.Join(dir, "logs"), time.Now()),
		os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
}

// DailyLog 按天滚动的日志 writer：每次写入检查日期，跨天自动切到新文件并清理旧文件。
type DailyLog struct {
	dir      string
	now      func() time.Time // 可注入，便于测试
	keepDays int

	mu  sync.Mutex
	day string
	f   *os.File
}

// OpenDailyLog 打开今天的日志文件并立即做一次旧文件清理。
// keepDays 为保留天数（含今天），非法值按 3 处理。
func OpenDailyLog(dir string, keepDays int) (*DailyLog, error) {
	if keepDays < MinKeepDays || keepDays > MaxKeepDays {
		keepDays = DefaultKeepDays
	}
	l := &DailyLog{dir: filepath.Join(dir, "logs"), now: time.Now, keepDays: keepDays}
	if err := l.rotateLocked(); err != nil {
		return nil, err
	}
	return l, nil
}

// SetKeepDays 更新保留天数（POST /config 即时生效）；下次 rotate 清理按新值。
func (l *DailyLog) SetKeepDays(days int) {
	if days < MinKeepDays || days > MaxKeepDays {
		return
	}
	l.mu.Lock()
	l.keepDays = days
	l.mu.Unlock()
}

// Write 实现 io.Writer。
func (l *DailyLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil || l.now().Format("2006-01-02") != l.day {
		if err := l.rotateLocked(); err != nil {
			return 0, err
		}
	}
	return l.f.Write(p)
}

// Close 关闭当前日志文件。
func (l *DailyLog) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}

// rotateLocked 切换到当天的日志文件并清理旧文件。调用方须持有 l.mu。
func (l *DailyLog) rotateLocked() error {
	if l.f != nil {
		_ = l.f.Close()
		l.f = nil
	}
	now := l.now()
	f, err := os.OpenFile(logPath(l.dir, now), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	l.f = f
	l.day = now.Format("2006-01-02")
	l.cleanupLocked()
	return nil
}

// cleanupLocked 删除超过保留天数的日志：只认 daemon-2006-01-02.log 格式的文件名，
// 按日期字符串比较（同日字典序即时间序）；其它文件（含旧版 daemon.log）不动。
func (l *DailyLog) cleanupLocked() {
	entries, err := os.ReadDir(l.dir)
	if err != nil {
		return
	}
	cutoff := l.now().AddDate(0, 0, -(l.keepDays - 1)).Format("2006-01-02")
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, logPrefix) || !strings.HasSuffix(name, logExt) {
			continue
		}
		day := strings.TrimSuffix(strings.TrimPrefix(name, logPrefix), logExt)
		if _, err := time.ParseInLocation("2006-01-02", day, time.Local); err != nil {
			continue // 名字不规范的文件不碰
		}
		if day < cutoff {
			_ = os.Remove(filepath.Join(l.dir, name))
		}
	}
}
