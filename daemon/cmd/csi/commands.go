package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
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
	logf, err := daemon.OpenLog(dir)
	if err != nil {
		return err
	}
	defer logf.Close()

	logger := log.New(io.MultiWriter(os.Stdout, logf), "", log.LstdFlags)
	port := daemon.Port()

	if err := daemon.WritePID(dir, os.Getpid()); err != nil {
		return err
	}
	defer daemon.RemovePID(dir)

	srv := server.New(port, logger)
	httpSrv := &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", port), // 协议 §7：仅监听回环
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.ListenAndServe() }()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	logger.Printf("csi %s serving on 127.0.0.1:%d (pid %d, id %s)",
		version.Version, port, os.Getpid(), id)

	select {
	case sig := <-sigCh:
		logger.Printf("received %v, shutting down", sig)
		_ = httpSrv.Close()
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// cmdStart 后台启动 daemon，幂等：已在运行则 no-op。
func cmdStart() error {
	dir, err := daemon.EnsureRunDir()
	if err != nil {
		return err
	}
	if pid, err := daemon.ReadPID(dir); err == nil && daemon.PIDAlive(pid) {
		fmt.Printf("csi already running (pid %d)\n", pid)
		return nil
	}
	daemon.RemovePID(dir) // 清理残留 pid 文件

	logf, err := daemon.OpenLog(dir)
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
	// 脱离父进程会话，父进程退出后 daemon 继续运行
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
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
	return fmt.Errorf("daemon did not become ready within 5s, see %s/logs/daemon.log", dir)
}

// cmdMCP 以 stdio 传输运行 MCP server，把 17 个浏览器工具暴露给 MCP 客户端，
// 内部转发到本机 daemon 的 POST /command。
func cmdMCP() error {
	return mcpserver.Run(context.Background())
}

// cmdStop 停止后台 daemon。
func cmdStop() error {
	dir, err := daemon.RunDir()
	if err != nil {
		return err
	}
	pid, err := daemon.ReadPID(dir)
	if err != nil || !daemon.PIDAlive(pid) {
		daemon.RemovePID(dir)
		fmt.Println("csi not running")
		return nil
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err := proc.Signal(syscall.SIGTERM); err != nil {
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
