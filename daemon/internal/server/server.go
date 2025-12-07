// Package server 实现 daemon 的 HTTP API 与 /ws 端点挂载。
package server

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"cdp-bridge/daemon/internal/version"
	"cdp-bridge/daemon/internal/ws"
)

// Server 聚合各内部组件，提供 HTTP Handler。
type Server struct {
	Hub     *ws.Hub
	Port    int
	started time.Time
	logger  *log.Logger
}

// New 组装 daemon 服务。port 仅用于 /status 展示。
func New(port int, logger *log.Logger) *Server {
	if logger == nil {
		logger = log.Default()
	}
	hub := ws.New(version.Version, logger)
	return &Server{
		Hub:     hub,
		Port:    port,
		started: time.Now(),
		logger:  logger,
	}
}

// Handler 返回 daemon 的 HTTP 路由。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", s.handleStatus)
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("/ws", s.Hub.HandleWS)
	return mux
}

// statusResponse /status 响应。
type statusResponse struct {
	Running            bool   `json:"running"`
	Version            string `json:"version"`
	ExtensionConnected bool   `json:"extension_connected"`
	ExtensionVersion   string `json:"extension_version"`
	UptimeSeconds      int64  `json:"uptime_seconds"`
	Port               int    `json:"port"`
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, statusResponse{
		Running:            true,
		Version:            version.Version,
		ExtensionConnected: s.Hub.Connected(),
		ExtensionVersion:   s.Hub.ExtensionVersion(),
		UptimeSeconds:      int64(time.Since(s.started).Seconds()),
		Port:               s.Port,
	})
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(v)
}
