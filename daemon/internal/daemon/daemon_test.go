package daemon

import "testing"

// RemovePID 条件删除：不匹配时不删，匹配时才删；pid<=0 无条件清理。
// （自重启时序：新进程已 WritePID，旧进程的 defer 不能误删新文件。）
func TestRemovePIDConditional(t *testing.T) {
	dir := t.TempDir()
	if err := WritePID(dir, 12345); err != nil {
		t.Fatal(err)
	}

	RemovePID(dir, 99999) // 不匹配：文件应保留
	if pid, err := ReadPID(dir); err != nil || pid != 12345 {
		t.Fatalf("mismatched RemovePID should keep file, got pid=%d err=%v", pid, err)
	}

	RemovePID(dir, 12345) // 匹配：删除
	if _, err := ReadPID(dir); err == nil {
		t.Fatal("matched RemovePID should remove file")
	}

	// 无条件清理（pid<=0）：残留文件也删
	if err := WritePID(dir, 22222); err != nil {
		t.Fatal(err)
	}
	RemovePID(dir, -1)
	if _, err := ReadPID(dir); err == nil {
		t.Fatal("RemovePID(-1) should remove unconditionally")
	}
}
