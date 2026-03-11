package main

// 隐式不变量：本包（cmd/csi）其他测试必须保持 t.Parallel()。
// TestRestartIntegration 拉起的替代进程是同一个测试二进制，会以 serve 参数
// 跑全量 suite；parallel 测试会在 park 处停住永不执行，而非 parallel 测试
// 会在替代 daemon 进程内真实运行，吃掉端口接管窗口。

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"testing"
	"time"
)

// helper 进程：CSI_HELPER_SERVE=1 时直接跑 serve 并退出。
// （标准 helper-process 模式：测试二进制 re-exec 自身当 daemon。）
func TestHelperServe(t *testing.T) {
	if os.Getenv("CSI_HELPER_SERVE") != "1" {
		return
	}
	if err := cmdServe(); err != nil {
		fmt.Fprintln(os.Stderr, "serve:", err)
		os.Exit(1)
	}
	os.Exit(0)
}

// freePort 拿一个当前空闲的端口（随后释放，bind 重试给足余量，TOCTOU 可接受）。
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func getStatus(t *testing.T, port int) (map[string]any, error) {
	t.Helper()
	client := &http.Client{Timeout: time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/status", port))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var st map[string]any
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err := json.Unmarshal(body, &st); err != nil {
		return nil, err
	}
	return st, nil
}

// 真实进程级自重启：serve 起在空闲端口 → POST /restart → 同一端口
// 换了一个 pid 继续服务（走 bind 退避重试路径）。
func TestRestartIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	dir := t.TempDir()
	port := freePort(t)

	cmd := exec.Command(os.Args[0], "-test.run=TestHelperServe")
	cmd.Env = append(os.Environ(),
		"CSI_HELPER_SERVE=1",
		"CSI_HOME="+dir,
		fmt.Sprintf("CSI_PORT=%d", port),
	)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		// 清理：新旧进程都可能活着，pid 文件里是现任
		if pid, err := readTestPID(dir); err == nil {
			if p, err := os.FindProcess(pid); err == nil {
				_ = p.Kill()
			}
		}
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	// 等旧进程就绪
	var st1 map[string]any
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var err error
		if st1, err = getStatus(t, port); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if st1 == nil {
		t.Fatal("daemon did not become ready in 5s")
	}
	pid1 := int(st1["pid"].(float64))

	// 触发自重启
	resp, err := http.Post(fmt.Sprintf("http://127.0.0.1:%d/restart", port), "application/json", nil)
	if err != nil {
		t.Fatalf("POST /restart: %v", err)
	}
	resp.Body.Close()

	// 等新进程接管（同端口、不同 pid）
	deadline = time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if st2, err := getStatus(t, port); err == nil {
			if pid2 := int(st2["pid"].(float64)); pid2 != pid1 {
				return // 成功
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("new daemon did not take over the port within 10s")
}

// readTestPID 读 helper 写的 pid 文件（复用 daemon.ReadPID，避免 import 循环这里手写）。
func readTestPID(dir string) (int, error) {
	data, err := os.ReadFile(dir + "/daemon.pid")
	if err != nil {
		return 0, err
	}
	var pid int
	if _, err := fmt.Sscanf(string(data), "%d", &pid); err != nil {
		return 0, err
	}
	return pid, nil
}
