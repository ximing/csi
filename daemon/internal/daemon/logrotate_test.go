package daemon

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// at 构造本地时间（只取日期部分有意义）。
func at(day string) time.Time {
	t, err := time.ParseInLocation("2006-01-02", day, time.Local)
	if err != nil {
		panic(err)
	}
	return t
}

func logDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func logFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dir, "logs"))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func hasFile(names []string, name string) bool {
	for _, n := range names {
		if n == name {
			return true
		}
	}
	return false
}

// 跨天写入自动滚动到以新日期命名的文件。
func TestDailyLogRotation(t *testing.T) {
	dir := logDir(t)
	now := at("2026-03-05")
	l, err := OpenDailyLog(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	l.now = func() time.Time { return now }

	if _, err := l.Write([]byte("day1\n")); err != nil {
		t.Fatal(err)
	}
	now = at("2026-03-06")
	if _, err := l.Write([]byte("day2\n")); err != nil {
		t.Fatal(err)
	}

	b1, err := os.ReadFile(filepath.Join(dir, "logs", "daemon-2026-03-05.log"))
	if err != nil || string(b1) != "day1\n" {
		t.Fatalf("03-05 文件内容 = %q, err = %v", b1, err)
	}
	b2, err := os.ReadFile(filepath.Join(dir, "logs", "daemon-2026-03-06.log"))
	if err != nil || string(b2) != "day2\n" {
		t.Fatalf("03-06 文件内容 = %q, err = %v", b2, err)
	}
}

// 打开时清理：只保留最近 3 天，且不动非日期命名的文件。
func TestDailyLogCleanupKeepsThreeDays(t *testing.T) {
	dir := logDir(t)
	logs := filepath.Join(dir, "logs")
	for _, f := range []string{
		"daemon-2026-03-01.log", "daemon-2026-03-02.log", // 应被删
		"daemon-2026-03-03.log", "daemon-2026-03-04.log", "daemon-2026-03-05.log", // 应保留
		"daemon.log", "daemon-old.log", "random.txt", // 不规范名字不动
	} {
		if err := os.WriteFile(filepath.Join(logs, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	l := &DailyLog{dir: filepath.Join(dir, "logs"), now: func() time.Time { return at("2026-03-05") }}
	if err := l.rotateLocked(); err != nil {
		t.Fatal(err)
	}
	defer l.Close()

	names := logFiles(t, dir)
	for _, gone := range []string{"daemon-2026-03-01.log", "daemon-2026-03-02.log"} {
		if hasFile(names, gone) {
			t.Errorf("%s 应被清理", gone)
		}
	}
	for _, keep := range []string{
		"daemon-2026-03-03.log", "daemon-2026-03-04.log", "daemon-2026-03-05.log",
		"daemon.log", "daemon-old.log", "random.txt",
	} {
		if !hasFile(names, keep) {
			t.Errorf("%s 应保留", keep)
		}
	}
}

// OpenLogFile 打开的是以今天日期命名的文件。
func TestOpenLogFileUsesToday(t *testing.T) {
	dir := logDir(t)
	f, err := OpenLogFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	want := logPrefix + time.Now().Format("2006-01-02") + logExt
	if filepath.Base(f.Name()) != want {
		t.Fatalf("文件名 = %s, want %s", filepath.Base(f.Name()), want)
	}
}
