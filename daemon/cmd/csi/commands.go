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

	"csi/daemon/internal/autostart"
	"csi/daemon/internal/daemon"
	mcpserver "csi/daemon/internal/mcp"
	"csi/daemon/internal/server"
	"csi/daemon/internal/update"
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
	defer daemon.RemovePID(dir, os.Getpid()) // 只删自己的：自重启时新进程的 pid 文件不能被误删

	srv := server.New(cfg, dir, logger)
	srv.OnConfigApplied = func(c daemon.Config) { daily.SetKeepDays(c.LogRetentionDays) }
	srv.UpdateChecker = &update.Checker{Dir: dir}

	brew := brewSupervised()
	if brew {
		srv.Supervisor = "brew-services" // 协议 §2.2
		if home, err := os.UserHomeDir(); err != nil {
			logger.Printf("autostart disable: %v", err)
		} else {
			maybeDisableCurlAutostart(true, home, autostart.Disable, logger.Printf)
		}
	}

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
		if restartSpawnsReplacement(brew) { // 协议 §2.6：brew 不 spawn
			if err := spawnReplacement(dir); err != nil {
				return err
			}
		}
		restartCh <- struct{}{}
		return nil
	}

	logger.Printf("csi %s serving on 127.0.0.1:%d (pid %d, id %s)",
		version.Version, port, os.Getpid(), id)

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if _, err := srv.UpdateChecker.Check(ctx, false); err != nil {
			logger.Printf("update check: %v", err)
		}
	}()

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
		// 非 brew：替代进程已拉起（bind 重试等本进程释放端口）。
		// brew：只退出，由 Homebrew KeepAlive 拉起新 serve（协议 §2.6）。
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
	daemon.RemovePID(dir, -1) // 清理残留 pid 文件（无条件）

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

// cmdMCP 以 stdio 传输运行 MCP server，把 21 个浏览器工具暴露给 MCP 客户端，
// 内部转发到本机 daemon 的 POST /command。
func cmdMCP() error {
	return mcpserver.Run(context.Background())
}

// cmdStop 停止后台 daemon。--force 跳过身份校验直接终止；brew 监督仍拒绝（协议 §2.2）。
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
// brew 监督直接拒绝，不走 stop+start（协议 §2.2）。
func cmdRestart() error {
	dir, err := daemon.RunDir()
	if err != nil {
		return err
	}
	if st, _ := fetchStatus(daemon.Port()); st != nil && st.Supervisor == "brew-services" {
		return errBrewSupervised
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

// stopDaemon 停止后台 daemon。force 跳过身份校验（防 PID 复用误杀，见 decideStop）；
// brew 监督在 force 之前先看 /status.supervisor，--force 同样拒绝（协议 §2.2）。
func stopDaemon(dir string, force bool) error {
	st, _ := fetchStatus(daemon.Port()) // 不可达时 st 为 nil；force 也要看 supervisor
	if st != nil && st.Supervisor == "brew-services" {
		return errBrewSupervised
	}
	pid, err := daemon.ReadPID(dir)
	if err != nil {
		daemon.RemovePID(dir, -1) // 文件缺失/损坏：无条件清理
		fmt.Println("csi not running")
		return nil
	}
	if !force {
		switch decideStop(pid, st, daemon.PIDAlive(pid)) {
		case stopNotRunning:
			daemon.RemovePID(dir, pid) // 进程已死：只删它的残留文件
			fmt.Println("csi not running")
			return nil
		case stopRefuseForeign:
			return &notCSIError{pid: pid}
		case stopRefuseBrew:
			return errBrewSupervised
		}
	}
	if !daemon.PIDAlive(pid) { // force 模式或身份确认后进程刚好退出
		daemon.RemovePID(dir, pid)
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
	PID        int    `json:"pid"`
	Supervisor string `json:"supervisor,omitempty"`
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
	stopRefuseBrew                        // brew 监督：拒绝（含 --force）
)

// errBrewSupervised 协议 §2.2：csi stop/restart（含 --force）见到 brew-services 必须拒绝。
var errBrewSupervised = errors.New("csi is managed by brew services; use brew services stop|restart csi")

// brewSupervised Homebrew service 注入 CSI_BREW_SERVICE=1（协议 §2.2）。
func brewSupervised() bool {
	return os.Getenv("CSI_BREW_SERVICE") == "1"
}

// restartSpawnsReplacement 协议 §2.6：brew 通道只优雅退出，由 KeepAlive 拉起新进程。
func restartSpawnsReplacement(brew bool) bool {
	return !brew
}

// maybeDisableCurlAutostart brew 通道启动时幂等拆掉 curl 登录自启，避免两套监督抢端口。
// disable 可注入，单测禁止碰本机 LaunchAgents。失败只打日志，不让 serve 失败。
func maybeDisableCurlAutostart(brew bool, home string, disable func(string) error, logf func(string, ...any)) {
	if !brew || disable == nil {
		return
	}
	if err := disable(home); err != nil && logf != nil {
		logf("autostart disable: %v", err)
	}
}

// decideStop 根据 /status 应答与进程活态决定 stop 行为。
// brew 监督（协议 §2.2）即使 pid 匹配也拒绝；其余仅当 /status 可达且 pid 匹配才放行。
func decideStop(pid int, st *statusReply, alive bool) stopDecision {
	if st != nil && st.Supervisor == "brew-services" {
		return stopRefuseBrew
	}
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
