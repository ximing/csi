package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"csi/daemon/internal/daemon"
	mcpserver "csi/daemon/internal/mcp"
	"csi/daemon/internal/server"
	"csi/daemon/internal/version"
)

// cmdServe 前台运行 daemon：日志同时写文件与 stdout，响应 SIGINT/SIGTERM 优雅退出。
func cmdServe() error {
	dir, err := daemon.EnsureRunDir()
	if err != nil {
		return err
	}
	id, err := daemon.EnsureIdentity(dir)
	if err != nil {
		return err
	}
	cfg, err := daemon.LoadConfig(dir)
	if err != nil {
		return err
	}
	daily, err := daemon.OpenDailyLog(dir, cfg.Values.LogRetentionDays)
	if err != nil {
		return err
	}
	defer daily.Close()

	logger := log.New(io.MultiWriter(os.Stdout, daily), "", log.LstdFlags)
	port := cfg.Values.Port

	ln, err := listenWithRetry(fmt.Sprintf("127.0.0.1:%d", port), 10*time.Second, logger) // 协议 §7：仅监听回环
	if err != nil {
		return fmt.Errorf("listen 127.0.0.1:%d: %w", port, err)
	}

	if err := daemon.WritePID(dir, os.Getpid()); err != nil {
		return err
	}
	defer daemon.RemovePID(dir)

	srv := server.New(cfg, dir, logger)
	srv.OnConfigApplied = func(c daemon.Config) { daily.SetKeepDays(c.LogRetentionDays) }
	httpSrv := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          logger, // handler panic 堆栈进滚动日志
	}

	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.Serve(ln) }()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	restartCh := make(chan struct{}, 1)
	srv.Restarter = func() error {
		if err := spawnReplacement(dir); err != nil {
			return err
		}
		restartCh <- struct{}{}
		return nil
	}

	logger.Printf("csi %s serving on 127.0.0.1:%d (pid %d, id %s)",
		version.Version, port, os.Getpid(), id)

	select {
	case sig := <-sigCh:
		logger.Printf("received %v, shutting down", sig)
		srv.Hub.Close() // 先唤醒所有在途工具调用，让 /command 尽快返回
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(ctx); err != nil {
			logger.Printf("http shutdown: %v", err)
		}
		return nil
	case <-restartCh:
		// 替代进程已拉起（bind 重试等本进程释放端口）；优雅退出。
		// HTTP 响应已随 handler 返回发出（Shutdown 等在途 handler 结束）。
		logger.Printf("restarted via /restart, shutting down")
		srv.Hub.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(ctx); err != nil {
			logger.Printf("http shutdown: %v", err)
		}
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// listenWithRetry 监听 addr；EADDRINUSE 时按 200ms 退避重试至 retryFor
// （自重启场景：新进程等旧进程释放端口）。
func listenWithRetry(addr string, retryFor time.Duration, logger *log.Logger) (net.Listener, error) {
	deadline := time.Now().Add(retryFor)
	for {
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			return ln, nil
		}
		if !errors.Is(err, syscall.EADDRINUSE) || time.Now().After(deadline) {
			return nil, err
		}
		logger.Printf("listen %s: port busy, retrying", addr)
		time.Sleep(200 * time.Millisecond)
	}
}

// spawnReplacement 拉起新的 serve 进程接管（配置可能已变，端口可能不同）。
// 与 startDaemon 不同：不做 already-running 检查——存活进程就是自己。
func spawnReplacement(dir string) error {
	logf, err := daemon.OpenLogFile(dir)
	if err != nil {
		return err
	}
	defer logf.Close()
	self, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(self, "serve")
	cmd.Env = os.Environ()
	cmd.Stdout = logf
	cmd.Stderr = logf
	detachProc(cmd)
	return cmd.Start()
}

// cmdStart 后台启动 daemon，幂等：已在运行则 no-op。
func cmdStart() error {
	return startDaemon()
}

// startDaemon 后台启动 daemon。"already running" 需 /status 身份确认，
// 防止 pid 文件里的 PID 被复用后误判。
func startDaemon() error {
	dir, err := daemon.EnsureRunDir()
	if err != nil {
		return err
	}
	if pid, err := daemon.ReadPID(dir); err == nil {
		st, _ := fetchStatus(daemon.Port()) // 不可达时 st 为 nil，按活态继续判定
		switch decideStart(pid, st, daemon.PIDAlive(pid)) {
		case startAlready:
			fmt.Printf("csi already running (pid %d)\n", pid)
			return nil
		case startConflict:
			return fmt.Errorf("found live process %d not responding as csi; run csi restart or csi stop --force", pid)
		}
	}
	daemon.RemovePID(dir) // 清理残留 pid 文件

	logf, err := daemon.OpenLogFile(dir)
	if err != nil {
		return err
	}
	defer logf.Close()

	self, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(self, "serve")
	cmd.Env = os.Environ()
	cmd.Stdout = logf
	cmd.Stderr = logf
	// 脱离父进程会话，父进程退出后 daemon 继续运行（平台相关，见 sysproc_*.go）
	detachProc(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}

	// 等待 healthz 就绪（最多 5s）
	port := daemon.Port()
	url := fmt.Sprintf("http://127.0.0.1:%d/healthz", port)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := ping(url); err == nil {
			pid, _ := daemon.ReadPID(dir)
			fmt.Printf("csi started (pid %d, port %d)\n", pid, port)
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("daemon did not become ready within 5s, see logs under %s/logs", dir)
}

// cmdMCP 以 stdio 传输运行 MCP server，把 17 个浏览器工具暴露给 MCP 客户端，
// 内部转发到本机 daemon 的 POST /command。
func cmdMCP() error {
	return mcpserver.Run(context.Background())
}

// cmdStop 停止后台 daemon。--force 跳过身份校验直接终止。
func cmdStop() error {
	force := false
	for _, a := range os.Args[2:] {
		switch a {
		case "--force", "-f":
			force = true
		default:
			return fmt.Errorf("unknown flag: %s", a)
		}
	}
	dir, err := daemon.RunDir()
	if err != nil {
		return err
	}
	return stopDaemon(dir, force)
}

// cmdRestart 重启后台 daemon：先按身份校验停止；身份不确认时，
// 因 restart 语义即用户明确要求重启，自动按 --force 处理。
func cmdRestart() error {
	dir, err := daemon.RunDir()
	if err != nil {
		return err
	}
	if err := stopDaemon(dir, false); err != nil {
		var nc *notCSIError
		if !errors.As(err, &nc) {
			return err
		}
		fmt.Printf("pid %d not responding as csi, force terminating for restart\n", nc.pid)
		if err := stopDaemon(dir, true); err != nil {
			return err
		}
	}
	return startDaemon()
}

// notCSIError pid 存活但身份不属于 csi（疑似 PID 被复用）。
type notCSIError struct{ pid int }

func (e *notCSIError) Error() string {
	return fmt.Sprintf("pid %d is alive but not responding as csi (possibly recycled PID); use csi stop --force", e.pid)
}

// stopDaemon 停止后台 daemon。force 跳过身份校验（防 PID 复用误杀，见 decideStop）。
func stopDaemon(dir string, force bool) error {
	pid, err := daemon.ReadPID(dir)
	if err != nil {
		daemon.RemovePID(dir)
		fmt.Println("csi not running")
		return nil
	}
	if !force {
		st, _ := fetchStatus(daemon.Port()) // 不可达时 st 为 nil，按活态继续判定
		switch decideStop(pid, st, daemon.PIDAlive(pid)) {
		case stopNotRunning:
			daemon.RemovePID(dir)
			fmt.Println("csi not running")
			return nil
		case stopRefuseForeign:
			return &notCSIError{pid: pid}
		}
	}
	if !daemon.PIDAlive(pid) { // force 模式或身份确认后进程刚好退出
		daemon.RemovePID(dir)
		fmt.Println("csi not running")
		return nil
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err := terminate(proc); err != nil {
		return err
	}
	// 等待退出（最多 5s）
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !daemon.PIDAlive(pid) {
			fmt.Printf("csi stopped (pid %d)\n", pid)
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("daemon (pid %d) did not exit within 5s", pid)
}

// statusReply /status 响应中 stop/start 身份校验需要的字段。
type statusReply struct {
	PID int `json:"pid"`
}

// fetchStatus GET /status（2s 超时）；不可达或非 200 返回错误。
func fetchStatus(port int) (*statusReply, error) {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/status", port))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	var st statusReply
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&st); err != nil {
		return nil, err
	}
	return &st, nil
}

// stopDecision stop 身份校验结论。
type stopDecision int

const (
	stopProceed       stopDecision = iota // 身份确认，可终止
	stopNotRunning                        // 进程已死：清理 pid 文件
	stopRefuseForeign                     // 进程活着但不是 csi（疑似 PID 复用）：拒绝
)

// decideStop 根据 /status 应答与进程活态决定 stop 行为。
// 仅当 /status 可达且 pid 匹配才放行；其余情况按活态区分清理或拒绝。
func decideStop(pid int, st *statusReply, alive bool) stopDecision {
	if st != nil && st.PID == pid {
		return stopProceed
	}
	if !alive {
		return stopNotRunning
	}
	return stopRefuseForeign
}

// startDecision start 的前置状态判定。
type startDecision int

const (
	startFresh    startDecision = iota // 无存活 daemon，正常启动
	startAlready                       // 已在运行（身份确认）
	startConflict                      // pid 活着但身份不确认（疑似 PID 复用）
)

// decideStart 判定 "already running"：仅当进程活着且 /status pid 匹配才算；
// 活着但身份不确认时报冲突，由用户决定 restart 或 stop --force。
func decideStart(pid int, st *statusReply, alive bool) startDecision {
	if !alive {
		return startFresh
	}
	if st != nil && st.PID == pid {
		return startAlready
	}
	return startConflict
}

// cmdStatus 查询 daemon 状态。
func cmdStatus() error {
	port := daemon.Port()
	url := fmt.Sprintf("http://127.0.0.1:%d/status", port)
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		fmt.Println("csi not running")
		return nil
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	fmt.Println(string(body))
	return nil
}

func ping(url string) error {
	client := &http.Client{Timeout: time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return nil
}
