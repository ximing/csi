package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
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
		{"brew 监督即使 pid 匹配也拒绝", 123, &statusReply{PID: 123, Supervisor: "brew-services"}, true, stopRefuseBrew},
		{"brew 监督进程已死也拒绝", 123, &statusReply{PID: 123, Supervisor: "brew-services"}, false, stopRefuseBrew},
		{"brew 监督 pid 不匹配也拒绝", 123, &statusReply{PID: 456, Supervisor: "brew-services"}, true, stopRefuseBrew},
		{"supervisor 其它值不走 brew 拒绝", 123, &statusReply{PID: 123, Supervisor: "other"}, true, stopProceed},
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
	if st.Supervisor != "" {
		t.Fatalf("supervisor = %q, want empty when omitted", st.Supervisor)
	}

	// 端口不可达 → 错误（调用方按 nil status 处理）
	if _, err := fetchStatus(1); err == nil {
		t.Fatal("fetchStatus to closed port should fail")
	}
}

// fetchStatus 解析协议 §2.2 的 supervisor。
func TestFetchStatusSupervisor(t *testing.T) {
	t.Parallel()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/status" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"running":true,"pid":7,"supervisor":"brew-services"}`)
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
	if st.Supervisor != "brew-services" {
		t.Fatalf("supervisor = %q, want brew-services", st.Supervisor)
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

// brew 拒绝文案必须指向 brew services stop|restart csi（协议 §2.2）。
func TestBrewSupervisedErrorMessage(t *testing.T) {
	t.Parallel()
	msg := errBrewSupervised.Error()
	if !strings.Contains(msg, "brew services stop|restart csi") {
		t.Fatalf("message = %q, want brew services stop|restart csi", msg)
	}
}

// restartSpawnsReplacement：brew 通道禁止 spawn，其它通道保持 spawn（协议 §2.6）。
func TestRestartSpawnsReplacement(t *testing.T) {
	t.Parallel()
	if restartSpawnsReplacement(true) {
		t.Fatal("brew 通道不得 spawnReplacement")
	}
	if !restartSpawnsReplacement(false) {
		t.Fatal("非 brew 通道仍须 spawnReplacement")
	}
}

// brewSupervised 只认 CSI_BREW_SERVICE=1。
func TestBrewSupervisedMatchesEnv(t *testing.T) {
	t.Parallel()
	got := brewSupervised()
	want := os.Getenv("CSI_BREW_SERVICE") == "1"
	if got != want {
		t.Fatalf("brewSupervised() = %v, want %v", got, want)
	}
}

// maybeDisableCurlAutostart：仅 brew 调用注入的 Disable；失败只打日志。
func TestMaybeDisableCurlAutostart(t *testing.T) {
	t.Parallel()
	var gotHome string
	calls := 0
	disable := func(home string) error {
		calls++
		gotHome = home
		return nil
	}
	var logs []string
	logf := func(format string, args ...any) {
		logs = append(logs, fmt.Sprintf(format, args...))
	}

	maybeDisableCurlAutostart(false, "/tmp/home", disable, logf)
	if calls != 0 {
		t.Fatal("非 brew 不得调用 Disable")
	}

	maybeDisableCurlAutostart(true, "/tmp/home", disable, logf)
	if calls != 1 || gotHome != "/tmp/home" {
		t.Fatalf("calls=%d home=%q", calls, gotHome)
	}

	fail := func(string) error { return fmt.Errorf("boom") }
	maybeDisableCurlAutostart(true, "/tmp/home", fail, logf)
	if len(logs) == 0 {
		t.Fatal("Disable 失败应打日志，不得让 serve 失败")
	}
}
