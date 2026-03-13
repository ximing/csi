// Package server 实现 daemon 的 HTTP API（协议 §2）与 /ws 端点挂载。
package server

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"csi/daemon/internal/backend"
	"csi/daemon/internal/daemon"
	"csi/daemon/internal/session"
	"csi/daemon/internal/tools"
	"csi/daemon/internal/version"
	"csi/daemon/internal/ws"
)

// Server 聚合各内部组件，提供 HTTP Handler。
type Server struct {
	Hub      *ws.Hub
	Executor *tools.Executor
	Sessions *session.Manager
	Port     int
	dir      string
	started  time.Time
	logger   *log.Logger

	// OnConfigApplied POST /config 保存成功后回调（如更新日志保留天数）；可为 nil。
	OnConfigApplied func(daemon.Config)

	// Restarter POST /restart 触发：拉起替代进程并安排本进程退出；nil 表示不支持。
	Restarter func() error

	cfgMu sync.RWMutex
	cfg   *daemon.ResolvedConfig
}

// New 组装 daemon 服务。cfg 为生效配置（端口仅用于 /status 展示；
// 工具超时灌进 Hub）。
func New(cfg *daemon.ResolvedConfig, dir string, logger *log.Logger) *Server {
	if logger == nil {
		logger = log.Default()
	}
	hub := ws.New(version.Version, logger)
	hub.SetToolTimeout(time.Duration(cfg.Values.ToolTimeoutSeconds) * time.Second)
	sessions := session.NewManager()
	be := backend.NewExtensionBackend(hub)
	return &Server{
		Hub:      hub,
		Executor: tools.NewExecutor(be, sessions),
		Sessions: sessions,
		Port:     cfg.Values.Port,
		dir:      dir,
		started:  time.Now(),
		logger:   logger,
		cfg:      cfg,
	}
}

// Handler 返回 daemon 的 HTTP 路由。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /command", s.handleCommand)
	mux.HandleFunc("GET /status", s.handleStatus)
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /config", s.handleGetConfig)
	mux.HandleFunc("POST /config", s.handlePostConfig)
	mux.HandleFunc("POST /restart", s.handleRestart)
	mux.HandleFunc("/ws", s.Hub.HandleWS)
	return mux
}

// commandRequest /command 请求体（协议 §2.1）。
type commandRequest struct {
	Action  string         `json:"action"`
	Args    map[string]any `json:"args"`
	Session string         `json:"session"`
}

// commandResponse /command 响应体：错误一律放 body，HTTP 200。
type commandResponse struct {
	Success bool   `json:"success"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}

func (s *Server) handleCommand(w http.ResponseWriter, r *http.Request) {
	var req commandRequest
	// upload 工具会带文件路径列表，请求体上限放宽到 64MB
	r.Body = http.MaxBytesReader(w, r.Body, 64<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, commandResponse{Success: false, Error: "bad request body: " + err.Error()})
		return
	}
	if req.Action == "" {
		writeJSON(w, commandResponse{Success: false, Error: "action is required"})
		return
	}

	data, err := s.Executor.Execute(r.Context(), req.Action, req.Session, req.Args)
	if err != nil {
		s.logger.Printf("command %s failed: %v", req.Action, err)
		writeJSON(w, commandResponse{Success: false, Error: err.Error()})
		return
	}
	writeJSON(w, commandResponse{Success: true, Data: data})
}

// statusResponse /status 响应（协议 §2.2）。
type statusResponse struct {
	Running            bool     `json:"running"`
	PID                int      `json:"pid"` // 供 stop/start 做身份校验，防 PID 复用误杀
	Version            string   `json:"version"`
	ExtensionConnected bool     `json:"extension_connected"`
	ExtensionVersion   string   `json:"extension_version"`
	UptimeSeconds      int64    `json:"uptime_seconds"`
	Sessions           []string `json:"sessions"`
	Port               int      `json:"port"`
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, statusResponse{
		Running:            true,
		PID:                os.Getpid(),
		Version:            version.Version,
		ExtensionConnected: s.Hub.Connected(),
		ExtensionVersion:   s.Hub.ExtensionVersion(),
		UptimeSeconds:      int64(time.Since(s.started).Seconds()),
		Sessions:           s.Sessions.Names(),
		Port:               s.Port,
	})
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// configEntry GET /config 单个配置项。
type configEntry struct {
	Value  int           `json:"value"`
	Source daemon.Source `json:"source"`
}

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	writeJSON(w, map[string]configEntry{
		"port":                 {s.cfg.Values.Port, s.cfg.Sources["port"]},
		"log_retention_days":   {s.cfg.Values.LogRetentionDays, s.cfg.Sources["log_retention_days"]},
		"tool_timeout_seconds": {s.cfg.Values.ToolTimeoutSeconds, s.cfg.Sources["tool_timeout_seconds"]},
	})
}

// configPatch POST /config 请求体：字段均可选，nil 表示不改。
type configPatch struct {
	Port               *int `json:"port"`
	LogRetentionDays   *int `json:"log_retention_days"`
	ToolTimeoutSeconds *int `json:"tool_timeout_seconds"`
}

func (s *Server) handlePostConfig(w http.ResponseWriter, r *http.Request) {
	var patch configPatch
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeJSON(w, commandResponse{Success: false, Error: "bad request body: " + err.Error()})
		return
	}
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()

	next := s.cfg.Values
	if patch.Port != nil {
		if s.cfg.Sources["port"] == daemon.SourceEnv {
			writeJSON(w, commandResponse{Success: false, Error: "port 被 CSI_PORT 环境变量覆盖，无法在此修改"})
			return
		}
		if err := daemon.ValidateField("port", *patch.Port); err != nil {
			writeJSON(w, commandResponse{Success: false, Error: err.Error()})
			return
		}
		next.Port = *patch.Port
	}
	if patch.LogRetentionDays != nil {
		if err := daemon.ValidateField("log_retention_days", *patch.LogRetentionDays); err != nil {
			writeJSON(w, commandResponse{Success: false, Error: err.Error()})
			return
		}
		next.LogRetentionDays = *patch.LogRetentionDays
	}
	if patch.ToolTimeoutSeconds != nil {
		if err := daemon.ValidateField("tool_timeout_seconds", *patch.ToolTimeoutSeconds); err != nil {
			writeJSON(w, commandResponse{Success: false, Error: err.Error()})
			return
		}
		next.ToolTimeoutSeconds = *patch.ToolTimeoutSeconds
	}

	// env 锁定端口（CSI_PORT 覆盖）时，落盘保留磁盘原值：
	// 内存生效值（next / s.cfg.Values）不动，避免把临时的 env 覆盖固化进 config.json。
	save := next
	if s.cfg.Sources["port"] == daemon.SourceEnv {
		save.Port = daemon.DiskPort(s.dir)
	}
	if err := daemon.SaveConfig(s.dir, save); err != nil {
		writeJSON(w, commandResponse{Success: false, Error: "save config: " + err.Error()})
		return
	}
	// 与实际监听端口比较：内存值可能已被上一次保存覆盖，
	// 二次保存（请求仍带新端口）时 restart_required 不能丢。
	restartRequired := patch.Port != nil && *patch.Port != s.Port
	s.cfg.Values = next
	if patch.Port != nil {
		s.cfg.Sources["port"] = daemon.SourceConfig
	}
	if patch.LogRetentionDays != nil {
		s.cfg.Sources["log_retention_days"] = daemon.SourceConfig
	}
	if patch.ToolTimeoutSeconds != nil {
		s.cfg.Sources["tool_timeout_seconds"] = daemon.SourceConfig
	}

	// 即时生效：工具超时直接改 Hub；保留天数经回调给 cmdServe 的 DailyLog。
	s.Hub.SetToolTimeout(time.Duration(next.ToolTimeoutSeconds) * time.Second)
	if s.OnConfigApplied != nil {
		s.OnConfigApplied(next)
	}
	writeJSON(w, commandResponse{Success: true, Data: map[string]any{"restart_required": restartRequired}})
}

// handleRestart 触发自重启：Restarter 拉起替代进程并安排本进程退出。
func (s *Server) handleRestart(w http.ResponseWriter, r *http.Request) {
	if s.Restarter == nil {
		writeJSON(w, commandResponse{Success: false, Error: "restart not supported"})
		return
	}
	if err := s.Restarter(); err != nil {
		s.logger.Printf("restart failed: %v", err)
		writeJSON(w, commandResponse{Success: false, Error: err.Error()})
		return
	}
	writeJSON(w, commandResponse{Success: true})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(v)
}
