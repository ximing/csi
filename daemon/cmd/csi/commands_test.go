package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// decideStop：身份匹配放行 / 进程已死清理 / 活着但非 csi 拒绝。
func TestDecideStop(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		pid   int
		st    *statusReply
		alive bool
		want  stopDecision
	}{
		{"身份匹配放行", 123, &statusReply{PID: 123}, true, stopProceed},
		{"进程已死且不可达则清理", 123, nil, false, stopNotRunning},
		{"status 不可达但活着则拒绝", 123, nil, true, stopRefuseForeign},
		{"status 可达但 pid 不匹配（复用）则拒绝", 123, &statusReply{PID: 456}, true, stopRefuseForeign},
		{"pid 不匹配且进程已死则清理", 123, &statusReply{PID: 456}, false, stopNotRunning},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := decideStop(c.pid, c.st, c.alive); got != c.want {
				t.Fatalf("decideStop(%d, %+v, %v) = %d, want %d", c.pid, c.st, c.alive, got, c.want)
			}
		})
	}
}

// decideStart：活进程 + /status pid 匹配才算 already running。
func TestDecideStart(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		pid   int
		st    *statusReply
		alive bool
		want  startDecision
	}{
		{"进程已死直接启动", 123, nil, false, startFresh},
		{"活着且身份匹配算已运行", 123, &statusReply{PID: 123}, true, startAlready},
		{"活着但 status 不可达算冲突", 123, nil, true, startConflict},
		{"活着但 pid 不匹配算冲突", 123, &statusReply{PID: 456}, true, startConflict},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := decideStart(c.pid, c.st, c.alive); got != c.want {
				t.Fatalf("decideStart(%d, %+v, %v) = %d, want %d", c.pid, c.st, c.alive, got, c.want)
			}
		})
	}
}

// fetchStatus：正常解析 pid；不可达返回错误。
func TestFetchStatus(t *testing.T) {
	t.Parallel()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/status" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"running":true,"pid":4321}`)
	}))
	defer ts.Close()

	port, err := strconv.Atoi(strings.TrimPrefix(ts.URL, "http://127.0.0.1:"))
	if err != nil {
		t.Fatalf("parse port: %v", err)
	}
	st, err := fetchStatus(port)
	if err != nil {
		t.Fatalf("fetchStatus: %v", err)
	}
	if st.PID != 4321 {
		t.Fatalf("pid = %d, want 4321", st.PID)
	}

	// 端口不可达 → 错误（调用方按 nil status 处理）
	if _, err := fetchStatus(1); err == nil {
		t.Fatal("fetchStatus to closed port should fail")
	}
}

// notCSIError 文案需引导用户使用 --force。
func TestNotCSIErrorMessage(t *testing.T) {
	t.Parallel()
	err := &notCSIError{pid: 999}
	msg := err.Error()
	if !strings.Contains(msg, "999") || !strings.Contains(msg, "--force") {
		t.Fatalf("message = %q", msg)
	}
}
