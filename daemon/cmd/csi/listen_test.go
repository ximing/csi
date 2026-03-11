package main

import (
	"log"
	"net"
	"testing"
	"time"
)

// 端口被占用但很快释放：重试后成功拿到。
func TestListenWithRetryEventuallyFree(t *testing.T) {
	t.Parallel()
	hold, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := hold.Addr().String()
	go func() {
		time.Sleep(300 * time.Millisecond)
		hold.Close()
	}()
	ln, err := listenWithRetry(addr, 3*time.Second, log.Default())
	if err != nil {
		t.Fatalf("listenWithRetry: %v", err)
	}
	ln.Close()
}

// 端口一直被占：超时返回错误。
func TestListenWithRetryTimeout(t *testing.T) {
	t.Parallel()
	hold, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer hold.Close()
	if _, err := listenWithRetry(hold.Addr().String(), 500*time.Millisecond, log.Default()); err == nil {
		t.Fatal("expected error when port stays busy")
	}
}
