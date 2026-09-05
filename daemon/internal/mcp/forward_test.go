package mcp

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestHTTPTimeout(t *testing.T) {
	if got := httpTimeout(60); got != 70*time.Second {
		t.Errorf("httpTimeout(60) = %v, want 70s", got)
	}
	if got := httpTimeout(0); got != 130*time.Second {
		t.Errorf("httpTimeout(0) = %v, want 130s", got)
	}
}

// configThenCommand 假 daemon：GET /config 返回 timeoutSec，POST /command 记一次。
func configThenCommand(t *testing.T, timeoutSec *atomic.Int64) (*httptest.Server, *atomic.Int64, *atomic.Int64) {
	t.Helper()
	var configs, commands atomic.Int64
	if timeoutSec == nil {
		timeoutSec = new(atomic.Int64)
		timeoutSec.Store(60)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/config":
			configs.Add(1)
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"tool_timeout_seconds":{"value":%d,"source":"config"}}`, timeoutSec.Load())
		case r.Method == http.MethodPost && r.URL.Path == "/command":
			commands.Add(1)
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"success":true,"data":{"tabs":[]}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &configs, &commands
}

func TestHTTPClientTimeoutFromConfig(t *testing.T) {
	srv, configs, commands := configThenCommand(t, nil)
	fwd := &forwarder{baseURL: srv.URL}

	client := fwd.httpClient(context.Background())
	if configs.Load() != 1 {
		t.Fatalf("GET /config count = %d, want 1", configs.Load())
	}
	if commands.Load() != 0 {
		t.Errorf("httpClient must not POST /command, got %d", commands.Load())
	}
	if client.Timeout != 70*time.Second {
		t.Errorf("client.Timeout = %v, want 70s (tool_timeout_seconds=60 + 10)", client.Timeout)
	}
}

func TestForwardCallGetsConfig(t *testing.T) {
	srv, configs, commands := configThenCommand(t, nil)
	mcpSrv := NewServer(srv.URL)

	res := callTool(t, mcpSrv, "list_tabs", nil)
	if res.IsError {
		t.Fatalf("unexpected error: %s", resultText(res))
	}
	if configs.Load() != 1 {
		t.Errorf("GET /config count = %d, want 1", configs.Load())
	}
	if commands.Load() != 1 {
		t.Errorf("POST /command count = %d, want 1", commands.Load())
	}

	fwd := &forwarder{baseURL: srv.URL}
	if got := fwd.httpClient(context.Background()).Timeout; got != 70*time.Second {
		t.Errorf("client.Timeout = %v, want 70s", got)
	}
}

func TestHTTPClientTimeoutFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)

	fwd := &forwarder{baseURL: srv.URL}
	if got := fwd.httpClient(context.Background()).Timeout; got != 130*time.Second {
		t.Errorf("unreachable /config: Timeout = %v, want 130s", got)
	}
}

func TestHTTPClientRereadsConfig(t *testing.T) {
	var timeoutSec atomic.Int64
	timeoutSec.Store(60)
	srv, _, _ := configThenCommand(t, &timeoutSec)
	fwd := &forwarder{baseURL: srv.URL}

	if got := fwd.httpClient(context.Background()).Timeout; got != 70*time.Second {
		t.Errorf("first Timeout = %v, want 70s", got)
	}
	timeoutSec.Store(90)
	if got := fwd.httpClient(context.Background()).Timeout; got != 100*time.Second {
		t.Errorf("after config change Timeout = %v, want 100s", got)
	}
}
