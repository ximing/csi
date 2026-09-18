// Package server 实现 daemon 的 HTTP API（协议 §2）与 /ws 端点挂载。
package server

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"csi/daemon/internal/backend"
	"csi/daemon/internal/daemon"
	"csi/daemon/internal/server/admin"
	"csi/daemon/internal/session"
	"csi/daemon/internal/tools"
	"csi/daemon/internal/update"
	"csi/daemon/internal/version"
	"csi/daemon/internal/ws"
)

// Server 聚合各内部组件，提供 HTTP Handler。
type Server struct {
	Hub      *ws.Hub
	Executor *tools.Executor
	Sessions *session.Manager
	Port     int
	BindHost string // 当前生效监听地址，用于 bind_host 变更的 restart_required 判定
	dir      string
	started  time.Time
	logger   *log.Logger

	// UpdateChecker 供 /status 暴露更新信息；nil 表示不输出相关字段。
	UpdateChecker *update.Checker

	// OnConfigApplied POST /config 保存成功后回调（如更新日志保留天数）；可为 nil。
	OnConfigApplied func(daemon.Config)

	// Restarter POST /restart 触发：非 brew 拉起替代进程并安排本进程退出；
	// brew 通道只安排退出（协议 §2.6）。nil 表示不支持。
	Restarter func() error

	// Supervisor 非空时 /status 输出该值（协议 §2.2：brew 通道为 brew-services）。
	Supervisor string

	cfgMu sync.RWMutex
	cfg   *daemon.ResolvedConfig
}

// New 组装 daemon 服务。cfg 为生效配置（端口与监听地址仅用于 /status 展示；
// 工具超时灌进 Hub）。
func New(cfg *daemon.ResolvedConfig, dir string, logger *log.Logger) *Server {
	if logger == nil {
		logger = log.Default()
	}
	hub := ws.New(version.Version, logger)
	hub.SetDaemonTools(tools.Names())
	hub.SetToolTimeout(time.Duration(cfg.Values.ToolTimeoutSeconds) * time.Second)
	sessions := session.NewManagerPersist(dir) // 落盘 sessions.json（协议 §3.4）
	be := backend.NewExtensionBackend(hub)
	ex := tools.NewExecutor(be, sessions)
	ex.Inventory = hub
	s := &Server{
		Hub:      hub,
		Executor: ex,
		Sessions: sessions,
		Port:     cfg.Values.Port,
		BindHost: cfg.Values.BindHost,
		dir:      dir,
		started:  time.Now(),
		logger:   logger,
		cfg:      cfg,
	}
	// WS 鉴权接线（协议 §2.7）：每次连接建立时读当前配置，
	// key 轮换对断开重连即时生效。
	hub.AuthFunc = func() (bool, string) {
		s.cfgMu.RLock()
		defer s.cfgMu.RUnlock()
		return s.cfg.AuthRequired(), s.cfg.Values.APIKey
	}
	return s
}

// Handler 返回 daemon 的 HTTP 路由。鉴权开启时整树包一层校验（协议 §2.7）。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /command", s.handleCommand)
	mux.HandleFunc("GET /status", s.handleStatus)
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /config", s.handleGetConfig)
	mux.HandleFunc("POST /config", s.handlePostConfig)
	mux.HandleFunc("POST /restart", s.handleRestart)
	mux.HandleFunc("/ws", s.Hub.HandleWS)
	mux.Handle("GET /admin", admin.Handler())
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/admin", http.StatusMovedPermanently)
	})
	return s.withAuth(mux)
}

// withAuth 鉴权中间件（协议 §2.7）。豁免：
//   - /healthz：探活，无信息泄露
//   - /admin：静态页面壳，是输入 key 的引导入口；页面内数据操作仍走带 key 的 API
//   - /ws：由 Hub.HandleWS 在 upgrade 前自行校验 ?api_key=（浏览器 WS 无法设
//     Authorization header，扩展只能走 query；协议 §2.7/§3.1）
//
// 每请求读内存配置 → 开关与 key 变更即时生效，无 restart_required。
func (s *Server) withAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz", "/admin", "/", "/ws":
			next.ServeHTTP(w, r)
			return
		}
		s.cfgMu.RLock()
		rc := s.cfg
		s.cfgMu.RUnlock()
		if !rc.AuthRequired() {
			next.ServeHTTP(w, r)
			return
		}
		if key := bearerKey(r.Header.Get("Authorization")); key != "" &&
			subtle.ConstantTimeCompare([]byte(key), []byte(rc.Values.APIKey)) == 1 {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("WWW-Authenticate", "Bearer")
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(commandResponse{Success: false, Error: "unauthorized", Code: "unauthorized"})
	})
}

// bearerKey 解析 Authorization: Bearer <key>；非 Bearer 方案返回空串。
func bearerKey(header string) string {
	const prefix = "Bearer "
	if len(header) > len(prefix) && strings.EqualFold(header[:len(prefix)], prefix) {
		return header[len(prefix):]
	}
	return ""
}

// commandRequest /command 请求体（协议 §2.1）。
type commandRequest struct {
	Action  string         `json:"action"`
	Args    map[string]any `json:"args"`
	Session string         `json:"session"`
}

// commandResponse /command 响应体：错误一律放 body，HTTP 200。
type commandResponse struct {
	Success bool           `json:"success"`
	Data    any            `json:"data,omitempty"`
	Error   string         `json:"error,omitempty"`
	Code    string         `json:"code,omitempty"`
	Details map[string]any `json:"details,omitempty"`
}

func (s *Server) handleCommand(w http.ResponseWriter, r *http.Request) {
	var req commandRequest
	// 整包传输层上限 64MB（协议 §2.1），不按 action 分级
	r.Body = http.MaxBytesReader(w, r.Body, 64<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, commandResponse{Success: false, Error: "bad request body: " + err.Error()})
		return
	}
	if req.Action == "" {
		writeJSON(w, commandResponse{Success: false, Error: "action is required"})
		return
	}
	// session 名限长（按字节）：防失控客户端刷爆 session map；业务错误走 body，不用 400。
	if len(req.Session) > session.MaxNameLength {
		writeJSON(w, commandResponse{Success: false, Error: fmt.Sprintf("session name too long (max %d)", session.MaxNameLength)})
		return
	}

	data, err := s.Executor.Execute(r.Context(), req.Action, req.Session, req.Args)
	if err != nil {
		s.logger.Printf("command %s failed: %v", req.Action, err)
		resp := commandResponse{Success: false, Error: err.Error()}
		var te *ws.ToolError
		if errors.As(err, &te) {
			resp.Code = te.Code
			resp.Details = te.Details
		}
		writeJSON(w, resp)
		return
	}
	writeJSON(w, commandResponse{Success: true, Data: data})
}

// statusResponse /status 响应（协议 §2.2）。
type statusResponse struct {
	Running            bool      `json:"running"`
	PID                int       `json:"pid"` // 供 stop/start 做身份校验，防 PID 复用误杀
	Version            string    `json:"version"`
	ExtensionConnected bool      `json:"extension_connected"`
	ExtensionVersion   string    `json:"extension_version"`
	ExtensionTools     *[]string `json:"extension_tools"`
	UptimeSeconds      int64     `json:"uptime_seconds"`
	Sessions           []string  `json:"sessions"`
	Port               int       `json:"port"`
	BindHost           string    `json:"bind_host"`
	UpdateAvailable    *bool     `json:"update_available,omitempty"`
	LatestVersion      string    `json:"latest_version,omitempty"`
	Supervisor         string    `json:"supervisor,omitempty"` // 协议 §2.2：空则省略
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	var extTools *[]string
	if t := s.Hub.ExtensionTools(); t != nil {
		cp := append([]string(nil), t...)
		extTools = &cp
	}
	resp := statusResponse{
		Running:            true,
		PID:                os.Getpid(),
		Version:            version.Version,
		ExtensionConnected: s.Hub.Connected(),
		ExtensionVersion:   s.Hub.ExtensionVersion(),
		ExtensionTools:     extTools,
		UptimeSeconds:      int64(time.Since(s.started).Seconds()),
		Sessions:           s.Sessions.Names(),
		Port:               s.Port,
		BindHost:           s.BindHost,
		Supervisor:         s.Supervisor,
	}
	if s.UpdateChecker != nil {
		if cache := s.UpdateChecker.ReadCache(); cache != nil {
			ua := update.NewerAvailable(version.Version, cache.LatestVersion)
			resp.UpdateAvailable = &ua
			resp.LatestVersion = cache.LatestVersion
		}
	}
	writeJSON(w, resp)
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// configEntry GET /config 单个配置项。Value 为 int / bool / string（bind_host）。
// api_key 特殊：value 恒为空串（永不回传明文），Set 表示是否已配置（协议 §2.4）。
type configEntry struct {
	Value  any           `json:"value"`
	Source daemon.Source `json:"source"`
	Set    *bool         `json:"set,omitempty"`
}

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	keySet := s.cfg.Values.APIKey != ""
	writeJSON(w, map[string]configEntry{
		"port":                 {s.cfg.Values.Port, s.cfg.Sources["port"], nil},
		"bind_host":            {s.cfg.Values.BindHost, s.cfg.Sources["bind_host"], nil},
		"log_retention_days":   {s.cfg.Values.LogRetentionDays, s.cfg.Sources["log_retention_days"], nil},
		"tool_timeout_seconds": {s.cfg.Values.ToolTimeoutSeconds, s.cfg.Sources["tool_timeout_seconds"], nil},
		"auth_enabled":         {s.cfg.Values.AuthEnabled, s.cfg.Sources["auth_enabled"], nil},
		"api_key":              {"", s.cfg.Sources["api_key"], &keySet},
	})
}

// configPatch POST /config 请求体：字段均可选，nil 表示不改。
type configPatch struct {
	Port               *int    `json:"port"`
	BindHost           *string `json:"bind_host"`
	LogRetentionDays   *int    `json:"log_retention_days"`
	ToolTimeoutSeconds *int    `json:"tool_timeout_seconds"`
	AuthEnabled        *bool   `json:"auth_enabled"`
	APIKey             *string `json:"api_key"`
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
	if patch.BindHost != nil {
		if s.cfg.Sources["bind_host"] == daemon.SourceEnv {
			writeJSON(w, commandResponse{Success: false, Error: "bind_host 被 CSI_HOST 环境变量覆盖，无法在此修改"})
			return
		}
		if err := daemon.ValidateBindHost(*patch.BindHost); err != nil {
			writeJSON(w, commandResponse{Success: false, Error: err.Error()})
			return
		}
		next.BindHost = *patch.BindHost
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
	if patch.APIKey != nil {
		// 空串 = 清除 key；非空则须合法。组合校验在下方统一做。
		if *patch.APIKey != "" {
			if err := daemon.ValidateAPIKey(*patch.APIKey); err != nil {
				writeJSON(w, commandResponse{Success: false, Error: err.Error()})
				return
			}
		}
		next.APIKey = *patch.APIKey
	}
	if patch.AuthEnabled != nil {
		next.AuthEnabled = *patch.AuthEnabled
	}
	// 组合校验（协议 §2.5）：auth_enabled:true 时必须有非空 key——
	// 含「开启鉴权的同时清空 key」，拒绝保存（fail-open 只兜底手改文件）。
	if next.AuthEnabled && next.APIKey == "" {
		writeJSON(w, commandResponse{Success: false, Error: "auth_enabled requires a non-empty api_key"})
		return
	}

	// env 锁定端口 / 监听地址（CSI_PORT / CSI_HOST 覆盖）时，落盘保留磁盘原值：
	// 内存生效值（next / s.cfg.Values）不动，避免把临时的 env 覆盖固化进 config.json。
	save := next
	if s.cfg.Sources["port"] == daemon.SourceEnv {
		save.Port = daemon.DiskPort(s.dir)
	}
	if s.cfg.Sources["bind_host"] == daemon.SourceEnv {
		save.BindHost = daemon.DiskBindHost(s.dir)
	}
	if err := daemon.SaveConfig(s.dir, save); err != nil {
		writeJSON(w, commandResponse{Success: false, Error: "save config: " + err.Error()})
		return
	}
	// 与实际监听地址比较：内存值可能已被上一次保存覆盖，
	// 二次保存（请求仍带新值）时 restart_required 不能丢。
	restartRequired := (patch.Port != nil && *patch.Port != s.Port) ||
		(patch.BindHost != nil && *patch.BindHost != s.BindHost)
	s.cfg.Values = next
	if patch.Port != nil {
		s.cfg.Sources["port"] = daemon.SourceConfig
	}
	if patch.BindHost != nil {
		s.cfg.Sources["bind_host"] = daemon.SourceConfig
	}
	if patch.LogRetentionDays != nil {
		s.cfg.Sources["log_retention_days"] = daemon.SourceConfig
	}
	if patch.ToolTimeoutSeconds != nil {
		s.cfg.Sources["tool_timeout_seconds"] = daemon.SourceConfig
	}
	if patch.AuthEnabled != nil {
		s.cfg.Sources["auth_enabled"] = daemon.SourceConfig
	}
	if patch.APIKey != nil {
		s.cfg.Sources["api_key"] = daemon.SourceConfig
	}

	// 即时生效：工具超时直接改 Hub；保留天数经回调给 cmdServe 的 DailyLog。
	s.Hub.SetToolTimeout(time.Duration(next.ToolTimeoutSeconds) * time.Second)
	if s.OnConfigApplied != nil {
		s.OnConfigApplied(next)
	}
	writeJSON(w, commandResponse{Success: true, Data: map[string]any{"restart_required": restartRequired}})
}

// handleRestart 触发自重启：Restarter 安排本进程退出（非 brew 会先 spawn）。
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
