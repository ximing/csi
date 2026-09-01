package main

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"csi/daemon/internal/update"
	"csi/daemon/internal/version"
)

// updateStub 记录 runUpdate 各依赖的调用顺序与次数。所有副作用均注入,
// 不打真网络、不动真文件系统(Replace 桩不调真 update.Replace)。
type updateStub struct {
	calls   []string
	running bool
	deps    updateDeps
	buf     bytes.Buffer
}

// newUpdateStub 构造一套全注入的 deps:latest 由 latest 参数指定。
func newUpdateStub(latest string) *updateStub {
	s := &updateStub{}
	s.deps = updateDeps{
		Self:       func() (string, error) { return "/fake/bin/csi", nil },
		IsHomebrew: func(string) bool { return false },
		Check: func(ctx context.Context, force bool) (*update.CheckResult, error) {
			s.calls = append(s.calls, "check")
			return &update.CheckResult{LatestVersion: latest, Tag: "v" + latest}, nil
		},
		Fetch: func(ctx context.Context, tag, goos, goarch string) (string, error) {
			s.calls = append(s.calls, "fetch:"+tag)
			return "/fake/tmp/new-bin", nil
		},
		Replace: func(selfPath, newBin string) (string, error) {
			s.calls = append(s.calls, "replace")
			return selfPath + ".bak", nil
		},
		Running: func() bool {
			s.calls = append(s.calls, "running")
			return s.running
		},
		Restart: func() error {
			s.calls = append(s.calls, "restart")
			return nil
		},
		Out: &s.buf,
	}
	return s
}

// called 报告某前缀的调用是否发生。
func (s *updateStub) called(prefix string) bool {
	for _, c := range s.calls {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

// callIndex 返回某前缀首次调用的位置,未调用返回 -1。
func (s *updateStub) callIndex(prefix string) int {
	for i, c := range s.calls {
		if strings.HasPrefix(c, prefix) {
			return i
		}
	}
	return -1
}

func TestUpdateAlreadyLatest(t *testing.T) {
	stub := newUpdateStub(version.Version)
	if err := runUpdate(nil, stub.deps); err != nil {
		t.Fatalf("runUpdate: %v", err)
	}
	if !strings.Contains(stub.buf.String(), "already up to date") {
		t.Fatalf("输出应含 already up to date,实际: %q", stub.buf.String())
	}
	if stub.called("fetch") || stub.called("replace") || stub.called("restart") {
		t.Fatalf("已是最新不应调 Fetch/Replace/Restart,调用序列: %v", stub.calls)
	}
}

func TestUpdateFlow(t *testing.T) {
	t.Run("daemon 在跑则重启", func(t *testing.T) {
		stub := newUpdateStub("99.0.0")
		stub.running = true
		if err := runUpdate(nil, stub.deps); err != nil {
			t.Fatalf("runUpdate: %v", err)
		}
		for _, want := range []string{"check", "fetch:v99.0.0", "replace", "running", "restart"} {
			if !stub.called(want) {
				t.Fatalf("缺少调用 %s,序列: %v", want, stub.calls)
			}
		}
		// Fetch 必须先于 Replace,Restart 必须在最后
		if !(stub.callIndex("fetch") < stub.callIndex("replace") &&
			stub.callIndex("replace") < stub.callIndex("restart")) {
			t.Fatalf("调用顺序应为 fetch→replace→restart,实际: %v", stub.calls)
		}
		if !strings.Contains(stub.buf.String(), ".bak") {
			t.Fatalf("应打印备份路径,实际: %q", stub.buf.String())
		}
	})

	t.Run("daemon 没在跑则不重启", func(t *testing.T) {
		stub := newUpdateStub("99.0.0")
		stub.running = false
		if err := runUpdate(nil, stub.deps); err != nil {
			t.Fatalf("runUpdate: %v", err)
		}
		if !stub.called("replace") {
			t.Fatalf("仍应替换二进制,序列: %v", stub.calls)
		}
		if stub.called("restart") {
			t.Fatalf("daemon 未运行不应 Restart,序列: %v", stub.calls)
		}
	})
}

func TestUpdateHomebrewRefused(t *testing.T) {
	stub := newUpdateStub("99.0.0")
	stub.deps.Self = func() (string, error) {
		return "/opt/homebrew/Cellar/csi/0.7.0/bin/csi", nil
	}
	stub.deps.IsHomebrew = update.IsHomebrewInstall // 用真判定,验证与真实路径集成
	err := runUpdate(nil, stub.deps)
	if err == nil {
		t.Fatal("Homebrew 安装应拒绝自更新")
	}
	if !strings.Contains(err.Error(), "brew upgrade") {
		t.Fatalf("错误文案应提示 brew upgrade,实际: %v", err)
	}
	if len(stub.calls) != 0 {
		t.Fatalf("Homebrew 拒绝时不应触网也不应动文件,调用: %v", stub.calls)
	}
}

func TestUpdateCheckOnly(t *testing.T) {
	stub := newUpdateStub("99.0.0")
	if err := runUpdate([]string{"--check"}, stub.deps); err != nil {
		t.Fatalf("runUpdate: %v", err)
	}
	out := stub.buf.String()
	for _, want := range []string{version.Version, "99.0.0", "update_available: true"} {
		if !strings.Contains(out, want) {
			t.Fatalf("--check 输出应含 %q,实际: %q", want, out)
		}
	}
	if stub.called("fetch") || stub.called("replace") || stub.called("restart") {
		t.Fatalf("--check 只看不动的,调用序列: %v", stub.calls)
	}
}

func TestUpdateUnknownFlag(t *testing.T) {
	stub := newUpdateStub("99.0.0")
	err := runUpdate([]string{"--bogus"}, stub.deps)
	if err == nil || !strings.Contains(err.Error(), "unknown flag") {
		t.Fatalf("未知旗标应报错,实际: %v", err)
	}
	if len(stub.calls) != 0 {
		t.Fatalf("未知旗标不应产生任何副作用,调用: %v", stub.calls)
	}
}

func TestUpdateQuiet(t *testing.T) {
	stub := newUpdateStub(version.Version)
	if err := runUpdate([]string{"--quiet"}, stub.deps); err != nil {
		t.Fatalf("runUpdate: %v", err)
	}
	if stub.buf.Len() != 0 {
		t.Fatalf("--quiet 正常路径不应输出,实际: %q", stub.buf.String())
	}
}

// restartHTTPServer 起一个假 /restart 端点,按 body 原样返回(HTTP 恒 200,
// 与 server.writeJSON 行为一致),返回其端口。
func restartHTTPServer(t *testing.T, body string) int {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, body)
	}))
	t.Cleanup(srv.Close)
	_, portStr, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	var port int
	fmt.Sscanf(portStr, "%d", &port)
	return port
}

func TestRestartDaemonSuccessFalseFallsBack(t *testing.T) {
	// 业务失败也返回 HTTP 200(本项目约定:错误走 body 的 success:false),
	// restartDaemon 必须解析 body,false 时走进程级回退。
	port := restartHTTPServer(t, `{"success":false,"error":"spawn boom"}`)
	fallbackCalled := false
	err := restartDaemonHTTP(port, func() error {
		fallbackCalled = true
		return nil
	})
	if !fallbackCalled {
		t.Fatal("success:false 应触发进程级回退")
	}
	if err != nil {
		t.Fatalf("回退成功后整体应成功,实际: %v", err)
	}
}

func TestRestartDaemonSuccessTrueNoFallback(t *testing.T) {
	port := restartHTTPServer(t, `{"success":true}`)
	fallbackCalled := false
	if err := restartDaemonHTTP(port, func() error {
		fallbackCalled = true
		return nil
	}); err != nil {
		t.Fatalf("success:true 不应报错: %v", err)
	}
	if fallbackCalled {
		t.Fatal("success:true 不应触发回退")
	}
}

func TestRestartDaemonUnreachableFallsBack(t *testing.T) {
	// 端口无人监听:HTTP 层失败,走回退(原有行为,顺带锁定)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close() // 立即释放,保证连接被拒
	fallbackCalled := false
	if err := restartDaemonHTTP(port, func() error {
		fallbackCalled = true
		return nil
	}); err != nil {
		t.Fatalf("回退成功后整体应成功,实际: %v", err)
	}
	if !fallbackCalled {
		t.Fatal("HTTP 不可达应触发回退")
	}
}
