# Options 设置页实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 CSI 扩展新增独立 options 设置页：查看 daemon 状态、修改 daemon 端口（落盘 + 一键自重启）、日志保留天数、工具默认超时、插件重连周期。

**Architecture:** daemon 新增 `~/.csi/config.json` 持久化配置与 `GET/POST /config`、`POST /restart` 端点（自重启 = 拉起 detached 新进程后立即退出，新进程靠 bind 退避重试接管端口）；扩展新增 options 页直接 fetch daemon HTTP API，插件侧设置走 `chrome.storage`。

**Tech Stack:** Go（daemon，无外部新依赖）、TypeScript + Vite（MV3 扩展）、chrome.i18n 双语。

**Spec:** `docs/superpowers/specs/2026-03-09-options-page-design.md`

## Global Constraints

- 提交必须回填虚构日期（`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`，+08:00），各任务提交步骤已给出具体日期，禁止用真实当天日期。
- 提交信息中文随意风格，结尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`（与历史一致）。
- 配置校验边界（spec 定死）：端口 1–65535；日志保留天数 1–30；工具超时 5–600 秒。
- 端口优先级：`CSI_PORT` env > config.json > 默认 10088；日志/超时不接受 env 覆盖。
- daemon HTTP 错误一律 `{success:false, error}` + HTTP 200（与 `/command` 风格一致）。
- **与 spec 的一处偏差（Chrome 平台限制）**：`chrome.alarms` 周期下限为 30 秒，spec 中重连周期的 10s 选项无法实现，改为 **30s（默认）/ 60s / 关闭**。
- daemon 所有改动后跑 `cd daemon && go test ./... && go vet ./...`；扩展改动后跑 `cd extension && npm run typecheck && npm run build`。

---

### Task 1: daemon config 包（config.json 读写 + 校验 + 优先级）

**Files:**
- Create: `daemon/internal/daemon/config.go`
- Test: `daemon/internal/daemon/config_test.go`
- Modify: `daemon/internal/daemon/daemon.go`（`Port()` 改为读 config）

**Interfaces:**
- Produces（后续任务依赖）:
  - `type Config struct { Port int; LogRetentionDays int; ToolTimeoutSeconds int }`（json tag 分别为 `port` / `log_retention_days` / `tool_timeout_seconds`）
  - `func DefaultConfig() Config` — `{10088, 3, 120}`
  - `type Source string`；常量 `SourceEnv / SourceConfig / SourceDefault`
  - `type ResolvedConfig struct { Values Config; Sources map[string]Source }`，Sources 的 key 为 `"port" / "log_retention_days" / "tool_timeout_seconds"`
  - `func LoadConfig(dir string) (*ResolvedConfig, error)` — dir 为 `~/.csi`（RunDir 返回值）
  - `func SaveConfig(dir string, cfg Config) error`
  - `func ValidateField(field string, v int) error` — field 同 Sources 的 key；非法 field 返回错误
  - `func Port() int`（改后）：env `CSI_PORT` > config.json > 10088

- [ ] **Step 1: 写失败测试** `daemon/internal/daemon/config_test.go`

```go
package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

// 缺文件 → 全默认值 + 全 default 来源。
func TestLoadConfigMissingFile(t *testing.T) {
	t.Parallel()
	rc, err := LoadConfig(t.TempDir())
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if rc.Values != DefaultConfig() {
		t.Fatalf("Values = %+v, want %+v", rc.Values, DefaultConfig())
	}
	for _, f := range []string{"port", "log_retention_days", "tool_timeout_seconds"} {
		if rc.Sources[f] != SourceDefault {
			t.Fatalf("Sources[%q] = %q, want default", f, rc.Sources[f])
		}
	}
}

// Save 后 Load 回读；来源变 config。
func TestSaveAndLoadConfig(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	want := Config{Port: 10090, LogRetentionDays: 7, ToolTimeoutSeconds: 60}
	if err := SaveConfig(dir, want); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	rc, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if rc.Values != want {
		t.Fatalf("Values = %+v, want %+v", rc.Values, want)
	}
	if rc.Sources["port"] != SourceConfig {
		t.Fatalf("Sources[port] = %q, want config", rc.Sources["port"])
	}
}

// 非法字段按默认值补齐，合法字段保留。
func TestLoadConfigInvalidFields(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	data := []byte(`{"port": 0, "log_retention_days": 99, "tool_timeout_seconds": 60}`)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	rc, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	want := Config{Port: DefaultPort, LogRetentionDays: 3, ToolTimeoutSeconds: 60}
	if rc.Values != want {
		t.Fatalf("Values = %+v, want %+v", rc.Values, want)
	}
	if rc.Sources["port"] != SourceDefault || rc.Sources["log_retention_days"] != SourceDefault {
		t.Fatalf("illegal fields should fall back to default source, got %+v", rc.Sources)
	}
}

// CSI_PORT 覆盖 config 文件，来源为 env。
func TestLoadConfigEnvOverride(t *testing.T) {
	dir := t.TempDir()
	if err := SaveConfig(dir, Config{Port: 10090, LogRetentionDays: 3, ToolTimeoutSeconds: 120}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CSI_PORT", "20000")
	rc, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if rc.Values.Port != 20000 || rc.Sources["port"] != SourceEnv {
		t.Fatalf("port = %d (%s), want 20000 (env)", rc.Values.Port, rc.Sources["port"])
	}
}

// ValidateField 边界。
func TestValidateField(t *testing.T) {
	t.Parallel()
	cases := []struct {
		field string
		v     int
		ok    bool
	}{
		{"port", 1, true}, {"port", 65535, true}, {"port", 0, false}, {"port", 65536, false},
		{"log_retention_days", 1, true}, {"log_retention_days", 30, true},
		{"log_retention_days", 0, false}, {"log_retention_days", 31, false},
		{"tool_timeout_seconds", 5, true}, {"tool_timeout_seconds", 600, true},
		{"tool_timeout_seconds", 4, false}, {"tool_timeout_seconds", 601, false},
		{"nonsense", 1, false},
	}
	for _, c := range cases {
		err := ValidateField(c.field, c.v)
		if c.ok != (err == nil) {
			t.Fatalf("ValidateField(%q, %d) err = %v, want ok=%v", c.field, c.v, err, c.ok)
		}
	}
}

// Port()：env > config > 默认。
func TestPortPriority(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CSI_HOME", dir)
	if got := Port(); got != DefaultPort {
		t.Fatalf("no config: Port() = %d, want %d", got, DefaultPort)
	}
	if err := SaveConfig(dir, Config{Port: 10091, LogRetentionDays: 3, ToolTimeoutSeconds: 120}); err != nil {
		t.Fatal(err)
	}
	if got := Port(); got != 10091 {
		t.Fatalf("config: Port() = %d, want 10091", got)
	}
	t.Setenv("CSI_PORT", "20001")
	if got := Port(); got != 20001 {
		t.Fatalf("env: Port() = %d, want 20001", got)
	}
}
```

注意 `TestPortPriority` 依赖 `CSI_HOME` 环境变量覆盖 RunDir——本任务一并实现（见 Step 3），否则测试无法隔离用户真实 `~/.csi`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && go test ./internal/daemon/ -run 'Config|Port' -v`
Expected: 编译失败（`LoadConfig` 等未定义）。

- [ ] **Step 3: 实现** `daemon/internal/daemon/config.go`

```go
// config.json：daemon 的持久化配置（~/.csi/config.json）。
// 端口优先级：CSI_PORT 环境变量 > config.json > 默认值；
// 日志保留天数与工具超时只走 config.json，不接受 env 覆盖。
package daemon

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// 配置项校验边界（协议 §2.4）。
const (
	MinPort, MaxPort                         = 1, 65535
	MinKeepDays, MaxKeepDays                 = 1, 30
	MinToolTimeoutSec, MaxToolTimeoutSec     = 5, 600
	DefaultKeepDays                          = 3
	DefaultToolTimeoutSec                    = 120
)

// Config config.json 的全部字段。
type Config struct {
	Port               int `json:"port"`
	LogRetentionDays   int `json:"log_retention_days"`
	ToolTimeoutSeconds int `json:"tool_timeout_seconds"`
}

// DefaultConfig 各字段默认值。
func DefaultConfig() Config {
	return Config{Port: DefaultPort, LogRetentionDays: DefaultKeepDays, ToolTimeoutSeconds: DefaultToolTimeoutSec}
}

// Source 配置值来源：env / config 文件 / 默认值。
type Source string

const (
	SourceEnv     Source = "env"
	SourceConfig  Source = "config"
	SourceDefault Source = "default"
)

// ResolvedConfig 生效值 + 每项来源（/config 端点展示用）。
type ResolvedConfig struct {
	Values  Config
	Sources map[string]Source
}

// configFields ResolvedConfig.Sources 的合法 key。
var configFields = []string{"port", "log_retention_days", "tool_timeout_seconds"}

// ValidateField 校验单个配置项；field 非法或值越界返回错误。
func ValidateField(field string, v int) error {
	switch field {
	case "port":
		if v < MinPort || v > MaxPort {
			return fmt.Errorf("port must be %d-%d", MinPort, MaxPort)
		}
	case "log_retention_days":
		if v < MinKeepDays || v > MaxKeepDays {
			return fmt.Errorf("log_retention_days must be %d-%d", MinKeepDays, MaxKeepDays)
		}
	case "tool_timeout_seconds":
		if v < MinToolTimeoutSec || v > MaxToolTimeoutSec {
			return fmt.Errorf("tool_timeout_seconds must be %d-%d", MinToolTimeoutSec, MaxToolTimeoutSec)
		}
	default:
		return fmt.Errorf("unknown config field %q", field)
	}
	return nil
}

func configPath(dir string) string { return filepath.Join(dir, "config.json") }

// LoadConfig 读取 config.json 并叠加 CSI_PORT 覆盖。
// 文件不存在 / 解析失败 / 字段非法一律回退默认值（解析失败不报错——
// daemon 不能因为一个写坏的配置文件起不来）。
func LoadConfig(dir string) (*ResolvedConfig, error) {
	rc := &ResolvedConfig{
		Values:  DefaultConfig(),
		Sources: map[string]Source{},
	}
	for _, f := range configFields {
		rc.Sources[f] = SourceDefault
	}
	data, err := os.ReadFile(configPath(dir))
	if err == nil {
		var file Config
		if json.Unmarshal(data, &file) == nil {
			if ValidateField("port", file.Port) == nil {
				rc.Values.Port = file.Port
				rc.Sources["port"] = SourceConfig
			}
			if ValidateField("log_retention_days", file.LogRetentionDays) == nil {
				rc.Values.LogRetentionDays = file.LogRetentionDays
				rc.Sources["log_retention_days"] = SourceConfig
			}
			if ValidateField("tool_timeout_seconds", file.ToolTimeoutSeconds) == nil {
				rc.Values.ToolTimeoutSeconds = file.ToolTimeoutSeconds
				rc.Sources["tool_timeout_seconds"] = SourceConfig
			}
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	// CSI_PORT 只覆盖端口（保留为临时覆盖手段，向后兼容）。
	if v := os.Getenv("CSI_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && ValidateField("port", n) == nil {
			rc.Values.Port = n
			rc.Sources["port"] = SourceEnv
		}
	}
	return rc, nil
}

// SaveConfig 全量写 config.json。
func SaveConfig(dir string, cfg Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(dir), data, 0o644)
}
```

同时修改 `daemon/internal/daemon/daemon.go`：

- `RunDir()` 开头加 `CSI_HOME` 覆盖（测试隔离用）：

```go
// RunDir 返回运行目录 ~/.csi；CSI_HOME 环境变量可覆盖（测试用）。
func RunDir() (string, error) {
	if v := os.Getenv("CSI_HOME"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".csi"), nil
}
```

- `Port()` 改为走 config（替换现有函数体）：

```go
// Port 返回监听端口：CSI_PORT 环境变量 > config.json > 默认值。
func Port() int {
	if dir, err := RunDir(); err == nil {
		if rc, err := LoadConfig(dir); err == nil {
			return rc.Values.Port
		}
	}
	return DefaultPort
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd daemon && go test ./internal/daemon/ -v && go vet ./...`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/daemon/config.go daemon/internal/daemon/config_test.go daemon/internal/daemon/daemon.go
GIT_AUTHOR_DATE="2026-03-10T10:18:00+08:00" GIT_COMMITTER_DATE="2026-03-10T10:18:00+08:00" git commit -m "daemon 配置落盘：config.json 读写 + 校验，端口优先级 env > 文件 > 默认

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 配置接入 serve / logrotate / hub

**Files:**
- Modify: `daemon/internal/daemon/logrotate.go`（保留天数参数化）
- Modify: `daemon/internal/daemon/logrotate_test.go`
- Modify: `daemon/internal/server/server.go:29-44`（`New` 改签名接收 config）
- Modify: `daemon/internal/server/server_test.go`（适配新签名）
- Modify: `daemon/cmd/csi/commands.go:24-63`（cmdServe 用 config）

**Interfaces:**
- Consumes: Task 1 的 `ResolvedConfig / LoadConfig / SaveConfig`。
- Produces:
  - `func OpenDailyLog(dir string, keepDays int) (*DailyLog, error)`
  - `func (l *DailyLog) SetKeepDays(days int)`（Task 3 的 POST /config 即时生效用）
  - `func server.New(cfg *daemon.ResolvedConfig, dir string, logger *log.Logger) *Server`（`Server.Port` 字段保留，取 `cfg.Values.Port`；`Hub.ToolTimeout` 取 `cfg.Values.ToolTimeoutSeconds`）

- [ ] **Step 1: 改 logrotate 测试覆盖参数化保留天数**

先看现有 `daemon/internal/daemon/logrotate_test.go` 的调用方式，把所有 `OpenDailyLog(dir)` 调用点改为 `OpenDailyLog(dir, 3)`，并新增：

```go
// SetKeepDays 即时生效：调小后下一次 rotate 清理按新值。
func TestDailyLogSetKeepDays(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	logs := filepath.Join(dir, "logs")
	if err := os.MkdirAll(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	// 造一个 5 天前的日志文件
	old := time.Now().AddDate(0, 0, -5)
	f, err := os.Create(logPath(logs, old))
	if err != nil {
		t.Fatal(err)
	}
	f.Close()

	l, err := OpenDailyLog(dir, 30)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if _, err := os.Stat(logPath(logs, old)); err != nil {
		t.Fatal("keepDays=30 should keep 5-day-old log")
	}
	l.SetKeepDays(2)
	l.now = func() time.Time { return time.Now().AddDate(0, 0, 1) } // 触发 rotate
	if _, err := l.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(logPath(logs, old)); !os.IsNotExist(err) {
		t.Fatal("keepDays=2 should remove 5-day-old log")
	}
}
```

（若现有测试文件里没有 `logPath` 可见性问题的直接复用；`l.now` 字段若现有测试已注入过 `now`，沿用同款写法。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && go test ./internal/daemon/ -run DailyLog -v`
Expected: 编译失败（`OpenDailyLog` 参数数量不匹配）。

- [ ] **Step 3: 实现 logrotate 参数化**

`daemon/internal/daemon/logrotate.go`：

- 删除常量 `logKeepDay`，`DailyLog` 加字段 `keepDays int`。
- `OpenDailyLog` 改签名：

```go
// OpenDailyLog 打开今天的日志文件并立即做一次旧文件清理。
// keepDays 为保留天数（含今天），非法值按 3 处理。
func OpenDailyLog(dir string, keepDays int) (*DailyLog, error) {
	if keepDays < MinKeepDays || keepDays > MaxKeepDays {
		keepDays = DefaultKeepDays
	}
	l := &DailyLog{dir: filepath.Join(dir, "logs"), now: time.Now, keepDays: keepDays}
	if err := l.rotateLocked(); err != nil {
		return nil, err
	}
	return l, nil
}

// SetKeepDays 更新保留天数（POST /config 即时生效）；下次 rotate 清理按新值。
func (l *DailyLog) SetKeepDays(days int) {
	if days < MinKeepDays || days > MaxKeepDays {
		return
	}
	l.mu.Lock()
	l.keepDays = days
	l.mu.Unlock()
}
```

- `cleanupLocked` 中 `logKeepDay` 改为 `l.keepDays`。
- 文件头注释“最多保留 3 天”改为“保留天数可配置（默认 3 天）”。

- [ ] **Step 4: server.New 接收 config**

`daemon/internal/server/server.go`：

```go
import (
	// 现有 import 保留，新增：
	"csi/daemon/internal/daemon"
)

// New 组装 daemon 服务。cfg 为生效配置（端口仅用于 /status 展示；
// 工具超时灌进 Hub）。
func New(cfg *daemon.ResolvedConfig, dir string, logger *log.Logger) *Server {
	if logger == nil {
		logger = log.Default()
	}
	hub := ws.New(version.Version, logger)
	hub.ToolTimeout = time.Duration(cfg.Values.ToolTimeoutSeconds) * time.Second
	sessions := session.NewManager()
	be := backend.NewExtensionBackend(hub)
	return &Server{
		Hub:      hub,
		Executor: tools.NewExecutor(be, sessions),
		Sessions: sessions,
		Port:     cfg.Values.Port,
		started:  time.Now(),
		logger:   logger,
	}
}
```

`Server` struct 中 `Port` 字段保留不动。`dir` 参数本任务暂存（Task 3 用）：struct 加字段 `dir string`，New 里赋值。

`daemon/internal/server/server_test.go` 中 `server.New(...)` 调用点适配：用 `daemon.LoadConfig(t.TempDir())` 构造 cfg（或手写 `&daemon.ResolvedConfig{Values: daemon.DefaultConfig(), Sources: ...}`），dir 传 `t.TempDir()`。

`daemon/cmd/csi/commands.go` `cmdServe`：

```go
	cfg, err := daemon.LoadConfig(dir)
	if err != nil {
		return err
	}
	daily, err := daemon.OpenDailyLog(dir, cfg.Values.LogRetentionDays)
	// ...
	port := cfg.Values.Port
	// ...
	srv := server.New(cfg, dir, logger)
```

（替换原来 `daemon.OpenDailyLog(dir)`、`port := daemon.Port()`、`server.New(port, logger)` 三处。）

- [ ] **Step 5: 全量测试 + 编译**

Run: `cd daemon && go test ./... && go vet ./...`
Expected: 全 PASS。

- [ ] **Step 6: 提交**

```bash
git add daemon/internal/daemon/logrotate.go daemon/internal/daemon/logrotate_test.go daemon/internal/server/server.go daemon/internal/server/server_test.go daemon/cmd/csi/commands.go
GIT_AUTHOR_DATE="2026-03-10T15:40:00+08:00" GIT_COMMITTER_DATE="2026-03-10T15:40:00+08:00" git commit -m "配置接入：日志保留天数参数化，工具超时灌进 Hub

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: GET/POST /config 端点

**Files:**
- Modify: `daemon/internal/server/server.go`
- Test: `daemon/internal/server/server_test.go`

**Interfaces:**
- Consumes: Task 1 `ValidateField / SaveConfig / ResolvedConfig`；Task 2 `Server.dir` 字段、`DailyLog.SetKeepDays`。
- Produces:
  - `GET /config` 响应：`{"port":{"value":10088,"source":"default"},"log_retention_days":{...},"tool_timeout_seconds":{...}}`
  - `POST /config` 请求：`{"port":10090,"log_retention_days":7,"tool_timeout_seconds":60}`（均为可选）；成功响应 `{"success":true,"data":{"restart_required":true|false}}`，失败 `{"success":false,"error":"..."}`
  - `Server.OnConfigApplied func(daemon.Config)`：保存成功后回调（cmdServe 用来调 `DailyLog.SetKeepDays`），可为 nil。

- [ ] **Step 1: 写失败测试**（追加到 `daemon/internal/server/server_test.go`）

```go
// GET /config：返回值与来源。
func TestGetConfig(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rc, _ := daemon.LoadConfig(dir)
	srv := New(rc, dir, nil)
	req := httptest.NewRequest("GET", "/config", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	var body map[string]map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if body["port"]["value"].(float64) != 10088 || body["port"]["source"] != "default" {
		t.Fatalf("port entry = %+v", body["port"])
	}
}

// POST /config：改超时即时生效（Hub.ToolTimeout 变化），改端口要求重启。
func TestPostConfig(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rc, _ := daemon.LoadConfig(dir)
	srv := New(rc, dir, nil)

	post := func(payload string) map[string]any {
		req := httptest.NewRequest("POST", "/config", strings.NewReader(payload))
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, req)
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("parse: %v", err)
		}
		return body
	}

	bad := post(`{"port": 0}`)
	if bad["success"].(bool) {
		t.Fatal("port=0 should be rejected")
	}

	ok := post(`{"tool_timeout_seconds": 60, "log_retention_days": 7, "port": 10090}`)
	if !ok["success"].(bool) {
		t.Fatalf("post failed: %v", ok)
	}
	if ok["data"].(map[string]any)["restart_required"].(bool) != true {
		t.Fatal("port change should require restart")
	}
	if srv.Hub.ToolTimeout != 60*time.Second {
		t.Fatalf("ToolTimeout = %v, want 60s", srv.Hub.ToolTimeout)
	}
	// 落盘可回读
	back, err := daemon.LoadConfig(dir)
	if err != nil || back.Values.Port != 10090 || back.Values.LogRetentionDays != 7 {
		t.Fatalf("reload = %+v, err %v", back, err)
	}
	// 不含端口的修改不要求重启
	ok2 := post(`{"tool_timeout_seconds": 90}`)
	if ok2["data"].(map[string]any)["restart_required"].(bool) != false {
		t.Fatal("non-port change should not require restart")
	}
}

// 端口被 CSI_PORT 覆盖时拒绝修改端口。
func TestPostConfigPortLockedByEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CSI_PORT", "20000")
	rc, _ := daemon.LoadConfig(dir)
	srv := New(rc, dir, nil)
	req := httptest.NewRequest("POST", "/config", strings.NewReader(`{"port": 10090}`))
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	var body map[string]any
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["success"].(bool) || !strings.Contains(body["error"].(string), "CSI_PORT") {
		t.Fatalf("env-locked port should be rejected with CSI_PORT hint, got %v", body)
	}
}
```

（文件顶部 import 按需补 `strings`、`time`、`csi/daemon/internal/daemon`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && go test ./internal/server/ -run Config -v`
Expected: 编译失败或 404（`/config` 未注册）。

- [ ] **Step 3: 实现**

`daemon/internal/server/server.go`：

`Server` struct 加字段：

```go
	// OnConfigApplied POST /config 保存成功后回调（如更新日志保留天数）；可为 nil。
	OnConfigApplied func(daemon.Config)
```

（`dir string` 字段 Task 2 已加；同时给 cfg 加读写锁：`cfgMu sync.RWMutex`、`cfg *daemon.ResolvedConfig`，New 里赋值 `cfg: cfg`。）

路由注册（`Handler()` 内）：

```go
	mux.HandleFunc("GET /config", s.handleGetConfig)
	mux.HandleFunc("POST /config", s.handlePostConfig)
	mux.HandleFunc("POST /restart", s.handleRestart) // 占位实现见下，Task 5 补全
```

占位 `handleRestart`（Task 3 必须有，否则编译不过；Task 5 替换函数体）：

```go
// handleRestart 占位：Restarter 机制在 Task 5 接入。
func (s *Server) handleRestart(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, commandResponse{Success: false, Error: "restart not supported"})
}
```

实现：

```go
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

	if err := daemon.SaveConfig(s.dir, next); err != nil {
		writeJSON(w, commandResponse{Success: false, Error: "save config: " + err.Error()})
		return
	}
	restartRequired := patch.Port != nil && *patch.Port != s.cfg.Values.Port
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
	s.Hub.ToolTimeout = time.Duration(next.ToolTimeoutSeconds) * time.Second
	if s.OnConfigApplied != nil {
		s.OnConfigApplied(next)
	}
	writeJSON(w, commandResponse{Success: true, Data: map[string]any{"restart_required": restartRequired}})
}
```

`cmdServe`（`daemon/cmd/csi/commands.go`）在 `srv := server.New(...)` 后加：

```go
	srv.OnConfigApplied = func(c daemon.Config) { daily.SetKeepDays(c.LogRetentionDays) }
```

- [ ] **Step 4: 全量测试**

Run: `cd daemon && go test ./... && go vet ./...`
Expected: 全 PASS（`/restart` 此任务仅占位，测试在 Task 5）。

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/server/server.go daemon/internal/server/server_test.go daemon/cmd/csi/commands.go
GIT_AUTHOR_DATE="2026-03-10T20:55:00+08:00" GIT_COMMITTER_DATE="2026-03-10T20:55:00+08:00" git commit -m "GET/POST /config：超时与保留天数改完即时生效，端口落盘待重启

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: serve 监听加 bind 退避重试

**Files:**
- Modify: `daemon/cmd/csi/commands.go`（`cmdServe` 改用 `net.Listen` + `httpSrv.Serve`）
- Test: `daemon/cmd/csi/listen_test.go`

**Interfaces:**
- Produces: `func listenWithRetry(addr string, retryFor time.Duration, logger *log.Logger) (net.Listener, error)` — `EADDRINUSE` 时每 200ms 重试至 `retryFor` 超时。

- [ ] **Step 1: 写失败测试** `daemon/cmd/csi/listen_test.go`

```go
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && go test ./cmd/csi/ -run ListenWithRetry -v`
Expected: 编译失败（未定义）。

- [ ] **Step 3: 实现**

`daemon/cmd/csi/commands.go`：

新增函数（import 补 `net`）：

```go
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
```

`cmdServe` 调整顺序——**先监听成功再写 pid 文件**（否则抢不到端口时留脏 pid）：

```go
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
		ErrorLog:          logger,
	}

	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.Serve(ln) }()
```

（删除原 `httpSrv.Addr` 字段与 `ListenAndServe` 调用；其余不变。）

- [ ] **Step 4: 全量测试**

Run: `cd daemon && go test ./... && go vet ./...`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add daemon/cmd/csi/commands.go daemon/cmd/csi/listen_test.go
GIT_AUTHOR_DATE="2026-03-11T10:05:00+08:00" GIT_COMMITTER_DATE="2026-03-11T10:05:00+08:00" git commit -m "serve 监听加 bind 退避重试：给自重启铺路，端口不变也能换进程

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: POST /restart 自重启

**Files:**
- Modify: `daemon/cmd/csi/commands.go`（`spawnReplacement` + restartCh）
- Modify: `daemon/internal/server/server.go`（`handleRestart`）
- Test: `daemon/internal/server/server_test.go`（追加）

**Interfaces:**
- Consumes: Task 4 的 cmdServe 结构。
- Produces:
  - `Server.Restarter func() error`：非 nil 时 `POST /restart` 调用它；响应 `{"success":true}`；错误响应 `{"success":false,"error":"..."}`。
  - `func spawnReplacement(dir string) error`（cmd/csi 包内）。

- [ ] **Step 1: 写失败测试**（追加到 `daemon/internal/server/server_test.go`）

```go
// POST /restart：Restarter 被调用；未设置时返回明确错误。
func TestRestartEndpoint(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	rc, _ := daemon.LoadConfig(dir)
	srv := New(rc, dir, nil)

	// 未设置 Restarter
	req := httptest.NewRequest("POST", "/restart", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)
	var body map[string]any
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["success"].(bool) {
		t.Fatal("restart without Restarter should fail")
	}

	// 设置后被调用
	called := false
	srv.Restarter = func() error { called = true; return nil }
	w2 := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w2, httptest.NewRequest("POST", "/restart", nil))
	json.Unmarshal(w2.Body.Bytes(), &body)
	if !body["success"].(bool) || !called {
		t.Fatalf("restart should call Restarter and succeed, got %v called=%v", body, called)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd daemon && go test ./internal/server/ -run Restart -v`
Expected: 编译失败（`srv.Restarter` 不存在）。

- [ ] **Step 3: 实现**

`daemon/internal/server/server.go`：

`Server` struct 加：

```go
	// Restarter POST /restart 触发：拉起替代进程并安排本进程退出；nil 表示不支持。
	Restarter func() error
```

`handleRestart`（替换 Task 3 的占位）：

```go
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
```

`daemon/cmd/csi/commands.go`：

新增（复用 detached 启动，但**不做** already-running 检查——存活进程就是自己）：

```go
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
```

`cmdServe` 加 restart 通道：

```go
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
```

select 加分支（与 sig 分支同样的优雅退出路径）：

```go
	select {
	case sig := <-sigCh:
		logger.Printf("received %v, shutting down", sig)
		srv.Hub.Close()
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
		// 不变
	}
```

- [ ] **Step 4: 全量测试**

Run: `cd daemon && go test ./... && go vet ./...`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add daemon/cmd/csi/commands.go daemon/internal/server/server.go daemon/internal/server/server_test.go
GIT_AUTHOR_DATE="2026-03-11T15:30:00+08:00" GIT_COMMITTER_DATE="2026-03-11T15:30:00+08:00" git commit -m "POST /restart：拉起替代进程后优雅退出，daemon 可以自我重启了

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 自重启集成测试（真实进程）

**Files:**
- Test: `daemon/cmd/csi/restart_test.go`

**Interfaces:**
- Consumes: Task 1 `CSI_HOME` 覆盖、Task 4 bind 重试、Task 5 `/restart`。

- [ ] **Step 1: 写集成测试** `daemon/cmd/csi/restart_test.go`

```go
package main

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
```

- [ ] **Step 2: 跑集成测试确认通过**

Run: `cd daemon && go test ./cmd/csi/ -run 'RestartIntegration|HelperServe' -v -timeout 60s`
Expected: PASS（新 pid 接管同端口）。若失败，看 `t.TempDir()` 下 `logs/` 的 helper 日志排查。

- [ ] **Step 3: 全量回归 + 提交**

Run: `cd daemon && go test ./... && go vet ./...`

```bash
git add daemon/cmd/csi/restart_test.go
GIT_AUTHOR_DATE="2026-03-11T21:12:00+08:00" GIT_COMMITTER_DATE="2026-03-11T21:12:00+08:00" git commit -m "自重启集成测试：真实进程换 pid 接管同端口

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: options 页脚手架 + popup 入口 + i18n

**Files:**
- Create: `extension/options.html`
- Create: `extension/src/options/options.css`
- Create: `extension/src/options/options.ts`
- Modify: `extension/manifest.json`
- Modify: `extension/vite.config.ts`
- Modify: `extension/popup.html`、`extension/src/popup/popup.ts`
- Modify: `extension/_locales/en/messages.json`、`extension/_locales/zh_CN/messages.json`
- Modify: `extension/src/shared/constants.ts`

**Interfaces:**
- Produces:
  - `STORAGE_KEYS.RECONCILE_PERIOD = 'reconcile_period_seconds'`、`DEFAULT_RECONCILE_PERIOD_SECONDS = 30`（Task 10 用）
  - options 页三个区块的 DOM id（Task 8/9/10 直接用）：见下方 HTML。

- [ ] **Step 1: constants.ts 增加存储 key**

`extension/src/shared/constants.ts` 的 `STORAGE_KEYS` 加一行，并新增常量：

```ts
/** Reconcile period setting (seconds; 0 = auto-reconnect off). */
RECONCILE_PERIOD: 'reconcile_period_seconds',
```

```ts
/** Default reconcile period in seconds (protocol §3.1). Chrome alarms floor is 30s. */
export const DEFAULT_RECONCILE_PERIOD_SECONDS = 30;
```

（`RECONCILE_PERIOD_MINUTES` 保留到 Task 10 由 ws-client 切换后删除。）

- [ ] **Step 2: options.html**（完整最终版 markup，三个区块的 DOM 一次到位）

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CSI Settings</title>
</head>
<body>
  <main id="options">
    <h1 id="title">CSI</h1>

    <section>
      <h2 id="status-heading">Daemon Status</h2>
      <div id="status-online" hidden>
        <dl id="status-grid">
          <dt id="dt-state"></dt><dd id="status-state"></dd>
          <dt id="dt-pid"></dt><dd id="status-pid"></dd>
          <dt id="dt-version"></dt><dd id="status-version"></dd>
          <dt id="dt-uptime"></dt><dd id="status-uptime"></dd>
          <dt id="dt-port"></dt><dd id="status-port"></dd>
          <dt id="dt-ext"></dt><dd id="status-ext"></dd>
          <dt id="dt-sessions"></dt><dd id="status-sessions"></dd>
        </dl>
      </div>
      <p id="status-offline" class="notice" hidden></p>
    </section>

    <section id="daemon-settings">
      <h2 id="daemon-settings-heading">Daemon Settings</h2>
      <p id="config-unsupported" class="notice" hidden></p>
      <div id="config-form">
        <label id="port-label" for="cfg-port"></label>
        <input id="cfg-port" type="number" min="1" max="65535" spellcheck="false">
        <p id="port-note" class="field-note" hidden></p>

        <label id="log-days-label" for="cfg-log-days"></label>
        <input id="cfg-log-days" type="number" min="1" max="30">

        <label id="tool-timeout-label" for="cfg-tool-timeout"></label>
        <input id="cfg-tool-timeout" type="number" min="5" max="600">

        <div class="button-row">
          <button id="btn-save-config" type="button"></button>
          <button id="btn-restart" type="button" hidden></button>
        </div>
        <p id="config-result" class="result"></p>
      </div>
    </section>

    <section>
      <h2 id="ext-settings-heading">Extension Settings</h2>
      <label id="reconcile-label" for="reconcile-period"></label>
      <select id="reconcile-period">
        <option value="30" id="reconcile-30"></option>
        <option value="60" id="reconcile-60"></option>
        <option value="0" id="reconcile-off"></option>
      </select>
      <p id="ext-result" class="result"></p>
    </section>

    <footer id="version-footer"></footer>
  </main>
  <script type="module" src="/src/options/options.ts"></script>
</body>
</html>
```

- [ ] **Step 3: options.css**

`extension/src/options/options.css`（风格沿用 popup.css）：

```css
:root {
  color-scheme: light dark;
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
}

#options {
  max-width: 520px;
  margin: 24px auto;
  padding: 0 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}

h2 {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}

section {
  border: 1px solid rgba(128, 128, 128, 0.35);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

#status-grid {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
}

#status-grid dt {
  opacity: 0.7;
}

#status-grid dd {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

label {
  font-size: 12px;
  opacity: 0.8;
}

input[type="number"], select {
  width: 160px;
  box-sizing: border-box;
  padding: 6px 8px;
  font-size: 12px;
  border: 1px solid #9ca3af;
  border-radius: 6px;
  background: transparent;
  color: inherit;
}

.field-note {
  margin: 0;
  font-size: 11px;
  color: #d97706;
}

.notice {
  margin: 0;
  font-size: 12px;
  color: #d97706;
}

.button-row {
  display: flex;
  gap: 8px;
  max-width: 340px;
}

button {
  flex: 1;
  padding: 6px 8px;
  font-size: 12px;
  border: 1px solid #9ca3af;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

button:hover {
  background: rgba(128, 128, 128, 0.15);
}

button:disabled, input:disabled {
  opacity: 0.5;
  cursor: default;
}

.result {
  margin: 0;
  min-height: 16px;
  font-size: 12px;
}

.result.ok {
  color: #16a34a;
}

.result.fail {
  color: #dc2626;
}

footer {
  font-size: 11px;
  opacity: 0.6;
  text-align: center;
}
```

- [ ] **Step 4: options.ts 最小骨架**（静态文案 + 页脚；区块逻辑后续任务追加）

```ts
import './options.css';

const i18n = (key: string, subs?: string | string[]): string => chrome.i18n.getMessage(key, subs) || key;

function applyStaticTexts(): void {
  document.getElementById('title')!.textContent = i18n('optionsTitle');
  document.getElementById('status-heading')!.textContent = i18n('statusHeading');
  document.getElementById('daemon-settings-heading')!.textContent = i18n('daemonSettingsHeading');
  document.getElementById('ext-settings-heading')!.textContent = i18n('extSettingsHeading');
  document.getElementById('dt-state')!.textContent = i18n('statusStateLabel');
  document.getElementById('dt-pid')!.textContent = i18n('statusPidLabel');
  document.getElementById('dt-version')!.textContent = i18n('statusVersionLabel');
  document.getElementById('dt-uptime')!.textContent = i18n('statusUptimeLabel');
  document.getElementById('dt-port')!.textContent = i18n('statusPortLabel');
  document.getElementById('dt-ext')!.textContent = i18n('statusExtLabel');
  document.getElementById('dt-sessions')!.textContent = i18n('statusSessionsLabel');
  document.getElementById('port-label')!.textContent = i18n('configPortLabel');
  document.getElementById('log-days-label')!.textContent = i18n('configLogDaysLabel');
  document.getElementById('tool-timeout-label')!.textContent = i18n('configToolTimeoutLabel');
  (document.getElementById('btn-save-config') as HTMLButtonElement).textContent = i18n('saveButton');
  (document.getElementById('btn-restart') as HTMLButtonElement).textContent = i18n('restartButton');
  document.getElementById('reconcile-label')!.textContent = i18n('reconcileLabel');
  document.getElementById('reconcile-30')!.textContent = i18n('reconcile30');
  document.getElementById('reconcile-60')!.textContent = i18n('reconcile60');
  document.getElementById('reconcile-off')!.textContent = i18n('reconcileOff');
  document.getElementById('version-footer')!.textContent = i18n('versionFooter', chrome.runtime.getManifest().version);
}

applyStaticTexts();
```

- [ ] **Step 5: manifest + vite + popup 入口**

`extension/manifest.json` 加：

```json
  "options_ui": {
    "page": "options.html",
    "open_in_tab": true
  },
```

`extension/vite.config.ts` 的 `rollupOptions.input` 加：

```ts
        options: r('options.html'),
```

`extension/popup.html` 在 `<footer>` 前加：

```html
    <a id="settings-link" href="#"></a>
```

`extension/src/popup/popup.ts` 的 `applyStaticTexts()` 末尾加：

```ts
  document.getElementById('settings-link')!.textContent = i18n('settingsLink');
```

文件底部（`applyStaticTexts();` 调用之后）加：

```ts
document.getElementById('settings-link')!.addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});
```

popup.css 给链接一点样式（追加）：

```css
#settings-link {
  font-size: 12px;
  text-align: center;
  color: inherit;
  opacity: 0.7;
}
```

- [ ] **Step 6: i18n 文案**（两个 messages.json 各加以下 key；en / zh_CN 对照）

en:

```json
  "settingsLink": { "message": "Settings" },
  "optionsTitle": { "message": "CSI Settings" },
  "statusHeading": { "message": "Daemon Status" },
  "daemonSettingsHeading": { "message": "Daemon Settings" },
  "extSettingsHeading": { "message": "Extension Settings" },
  "statusStateLabel": { "message": "State" },
  "statusPidLabel": { "message": "PID" },
  "statusVersionLabel": { "message": "Daemon version" },
  "statusUptimeLabel": { "message": "Uptime" },
  "statusPortLabel": { "message": "Port" },
  "statusExtLabel": { "message": "Extension connected" },
  "statusSessionsLabel": { "message": "Sessions" },
  "statusRunning": { "message": "Running" },
  "statusOffline": { "message": "Daemon not running — start it with `csi start` in a terminal" },
  "statusYes": { "message": "yes ($VER$)", "placeholders": { "ver": { "content": "$1" } } },
  "statusNo": { "message": "no" },
  "configPortLabel": { "message": "Daemon port" },
  "configLogDaysLabel": { "message": "Log retention (days)" },
  "configToolTimeoutLabel": { "message": "Tool timeout (seconds)" },
  "configPortEnvNote": { "message": "Overridden by the CSI_PORT environment variable — cannot change here" },
  "configUnsupported": { "message": "This daemon version does not support remote configuration — please upgrade the daemon" },
  "saveButton": { "message": "Save" },
  "restartButton": { "message": "Restart daemon to apply port" },
  "configSaved": { "message": "Saved" },
  "configSaveFailed": { "message": "Save failed: $ERR$", "placeholders": { "err": { "content": "$1" } } },
  "configInvalid": { "message": "Invalid value: $ERR$", "placeholders": { "err": { "content": "$1" } } },
  "restartInProgress": { "message": "Restarting…" },
  "restartOk": { "message": "Daemon restarted on port $PORT$ — extension reconnected", "placeholders": { "port": { "content": "$1" } } },
  "restartFailedOldAlive": { "message": "Restart failed — daemon is still on the old port; see ~/.csi/logs" },
  "restartFailedDown": { "message": "Restart failed — daemon is down; see ~/.csi/logs and start it with `csi start`" },
  "reconcileLabel": { "message": "Auto-reconnect interval" },
  "reconcile30": { "message": "Every 30 seconds (default)" },
  "reconcile60": { "message": "Every 60 seconds" },
  "reconcileOff": { "message": "Off" },
  "extSaved": { "message": "Saved" },
  "uptimeFormat": { "message": "$H$h $M$m $S$s", "placeholders": { "h": { "content": "$1" }, "m": { "content": "$2" }, "s": { "content": "$3" } } },
  "uptimeFormatShort": { "message": "$M$m $S$s", "placeholders": { "m": { "content": "$1" }, "s": { "content": "$2" } } },
```

zh_CN 同 key，message 分别为：设置 / CSI 设置 / 守护进程状态 / 守护进程设置 / 插件设置 / 状态 / PID / daemon 版本 / 已运行 / 端口 / 扩展已连接 / 会话 / 运行中 / daemon 未运行——请在终端执行 `csi start` 启动 / 是（$VER$）/ 否 / daemon 端口 / 日志保留天数 / 工具超时（秒）/ 被 CSI_PORT 环境变量覆盖，无法在此修改 / 当前 daemon 版本不支持远程配置，请升级 daemon / 保存 / 重启 daemon 使端口生效 / 已保存 / 保存失败：$ERR$ / 非法取值：$ERR$ / 重启中… / daemon 已重启到端口 $PORT$，扩展已重连 / 重启失败——daemon 仍在原端口运行，请查看 ~/.csi/logs / 重启失败——daemon 已停止，请查看 ~/.csi/logs 并用 `csi start` 启动 / 自动重连间隔 / 每 30 秒（默认）/ 每 60 秒 / 关闭 / 已保存 / $H$ 小时 $M$ 分 $S$ 秒 / $M$ 分 $S$ 秒。

（写文件时逐条展开为标准 messages.json 格式，placeholder 定义与 en 一致。）

- [ ] **Step 7: 验证构建**

Run: `cd extension && npm run typecheck && npm run build`
Expected: 通过；`dist/options.html`、`dist/options.js` 生成。

- [ ] **Step 8: 提交**

```bash
git add extension/
GIT_AUTHOR_DATE="2026-03-12T10:20:00+08:00" GIT_COMMITTER_DATE="2026-03-12T10:20:00+08:00" git commit -m "options 设置页脚手架：三区块骨架 + popup 入口 + 双语 i18n

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: 状态区块（轮询 /status）

**Files:**
- Modify: `extension/src/options/options.ts`

**Interfaces:**
- Consumes: Task 7 的 DOM id。
- Produces:
  - `function daemonHttpBase(wsUrl: string): string` — 从 WS URL 推导 HTTP 基址（Task 9 复用）。
  - `interface DaemonStatus` — `/status` 响应类型（Task 9 复用）。

- [ ] **Step 1: 实现**（追加到 `options.ts`，放在 `applyStaticTexts();` 之后）

```ts
import { DEFAULT_WS_URL, STORAGE_KEYS } from '../shared/constants';

/** /status 响应（protocol §2.2）。 */
interface DaemonStatus {
  running: boolean;
  pid: number;
  version: string;
  extension_connected: boolean;
  extension_version: string;
  uptime_seconds: number;
  sessions: string[];
  port: number;
}

/** 从 ws://host:port/ws 推导 http://host:port；非法输入回退默认端口。 */
function daemonHttpBase(wsUrl: string): string {
  try {
    const u = new URL(wsUrl || DEFAULT_WS_URL);
    return `http://${u.host}`;
  } catch {
    return 'http://127.0.0.1:10088';
  }
}

async function currentDaemonBase(): Promise<string> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.URL);
  return daemonHttpBase((stored[STORAGE_KEYS.URL] as string) || '');
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? i18n('uptimeFormat', [String(h), String(m), String(s)])
    : i18n('uptimeFormatShort', [String(m), String(s)]);
}

let lastStatus: DaemonStatus | null = null; // Task 9 重启流程要用端口信息

async function refreshStatus(): Promise<void> {
  const online = document.getElementById('status-online')!;
  const offline = document.getElementById('status-offline')!;
  try {
    const resp = await fetch(`${await currentDaemonBase()}/status`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const st = (await resp.json()) as DaemonStatus;
    lastStatus = st;
    online.hidden = false;
    offline.hidden = true;
    document.getElementById('status-state')!.textContent = i18n('statusRunning');
    document.getElementById('status-pid')!.textContent = String(st.pid);
    document.getElementById('status-version')!.textContent = st.version;
    document.getElementById('status-uptime')!.textContent = formatUptime(st.uptime_seconds);
    document.getElementById('status-port')!.textContent = String(st.port);
    document.getElementById('status-ext')!.textContent = st.extension_connected
      ? i18n('statusYes', st.extension_version || '?')
      : i18n('statusNo');
    document.getElementById('status-sessions')!.textContent = st.sessions.length ? st.sessions.join(', ') : '—';
  } catch {
    lastStatus = null;
    online.hidden = true;
    offline.hidden = false;
    offline.textContent = i18n('statusOffline');
  }
  updateSettingsAvailability();
}

// daemon 不在线时禁用设置表单（Task 9 的控件此时可能还不存在，判空跳过）。
function updateSettingsAvailability(): void {
  const form = document.getElementById('config-form');
  if (!form) return;
  const disabled = lastStatus === null;
  for (const el of form.querySelectorAll('input, button')) {
    (el as HTMLInputElement | HTMLButtonElement).disabled = disabled;
  }
}

void refreshStatus();
setInterval(() => void refreshStatus(), 3000);
```

（文件顶部 import 移到头部，与现有 import 合并。）

- [ ] **Step 2: 验证构建**

Run: `cd extension && npm run typecheck && npm run build`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add extension/src/options/options.ts
GIT_AUTHOR_DATE="2026-03-12T14:45:00+08:00" GIT_COMMITTER_DATE="2026-03-12T14:45:00+08:00" git commit -m "设置页状态区块：3s 轮询 /status，daemon 不在线禁用设置表单

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: 守护进程设置区块（/config + 一键重启 + 自动切换重连）

**Files:**
- Modify: `extension/src/options/options.ts`

**Interfaces:**
- Consumes: Task 8 的 `daemonHttpBase / currentDaemonBase / lastStatus`；`CONNECT` runtime message（复用 popup 已有的，`wsClient.connect(url)` 会落 storage 并重连）。

- [ ] **Step 1: 实现**（追加到 `options.ts` 尾部）

```ts
// ---------- daemon 设置区块 ----------

type ConfigSource = 'env' | 'config' | 'default';

interface ConfigResponse {
  port: { value: number; source: ConfigSource };
  log_retention_days: { value: number; source: ConfigSource };
  tool_timeout_seconds: { value: number; source: ConfigSource };
}

const cfgPort = document.getElementById('cfg-port') as HTMLInputElement;
const cfgLogDays = document.getElementById('cfg-log-days') as HTMLInputElement;
const cfgToolTimeout = document.getElementById('cfg-tool-timeout') as HTMLInputElement;
const portNote = document.getElementById('port-note')!;
const saveConfigButton = document.getElementById('btn-save-config') as HTMLButtonElement;
const restartButton = document.getElementById('btn-restart') as HTMLButtonElement;
const configResult = document.getElementById('config-result')!;
const configUnsupported = document.getElementById('config-unsupported')!;

function showConfigResult(key: string, ok: boolean, subs?: string | string[]): void {
  configResult.className = ok ? 'result ok' : 'result fail';
  configResult.textContent = i18n(key, subs);
}

async function loadConfig(): Promise<void> {
  try {
    const resp = await fetch(`${await currentDaemonBase()}/config`, { signal: AbortSignal.timeout(2000) });
    if (resp.status === 404) throw new Error('unsupported');
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const cfg = (await resp.json()) as ConfigResponse;
    cfgPort.value = String(cfg.port.value);
    cfgLogDays.value = String(cfg.log_retention_days.value);
    cfgToolTimeout.value = String(cfg.tool_timeout_seconds.value);
    if (cfg.port.source === 'env') {
      cfgPort.disabled = true;
      portNote.hidden = false;
      portNote.textContent = i18n('configPortEnvNote');
    }
  } catch {
    // 404（旧 daemon）或不可达：隐藏表单，提示不支持（不可达时状态区块已禁用控件）
    configUnsupported.hidden = false;
    configUnsupported.textContent = i18n('configUnsupported');
    document.getElementById('config-form')!.style.display = 'none';
  }
}

// 前端校验与 daemon 一致（daemon 仍是权威校验）。
function validateInputs(): string | null {
  const port = Number(cfgPort.value);
  const days = Number(cfgLogDays.value);
  const timeout = Number(cfgToolTimeout.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port must be 1-65535';
  if (!Number.isInteger(days) || days < 1 || days > 30) return 'log_retention_days must be 1-30';
  if (!Number.isInteger(timeout) || timeout < 5 || timeout > 600) return 'tool_timeout_seconds must be 5-600';
  return null;
}

let pendingRestartPort: number | null = null;

saveConfigButton.addEventListener('click', async () => {
  const invalid = validateInputs();
  if (invalid) {
    showConfigResult('configInvalid', false, invalid);
    return;
  }
  saveConfigButton.disabled = true;
  try {
    const patch: Record<string, number> = {
      log_retention_days: Number(cfgLogDays.value),
      tool_timeout_seconds: Number(cfgToolTimeout.value),
    };
    if (!cfgPort.disabled) patch.port = Number(cfgPort.value);
    const resp = await fetch(`${await currentDaemonBase()}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(3000),
    });
    const body = (await resp.json()) as { success: boolean; error?: string; data?: { restart_required: boolean } };
    if (!body.success) {
      showConfigResult('configSaveFailed', false, body.error || 'unknown');
      return;
    }
    showConfigResult('configSaved', true);
    const portChanged = patch.port !== undefined && patch.port !== lastStatus?.port;
    pendingRestartPort = body.data?.restart_required && portChanged ? patch.port! : null;
    restartButton.hidden = pendingRestartPort === null;
  } catch (err) {
    showConfigResult('configSaveFailed', false, (err as Error).message);
  } finally {
    saveConfigButton.disabled = false;
  }
});

async function pollHealthz(base: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) return true;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

restartButton.addEventListener('click', async () => {
  if (pendingRestartPort === null) return;
  const newPort = pendingRestartPort;
  const oldBase = await currentDaemonBase();
  restartButton.disabled = true;
  showConfigResult('restartInProgress', true);
  try {
    await fetch(`${oldBase}/restart`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch {
    // 旧进程可能已经退出，不影响后续轮询
  }
  const newBase = `http://127.0.0.1:${newPort}`;
  if (await pollHealthz(newBase, 10_000)) {
    // 切换 WS URL 并让 background 重连（CONNECT 会落 storage）
    await chrome.runtime.sendMessage({ type: 'CONNECT', url: `ws://127.0.0.1:${newPort}/ws` });
    pendingRestartPort = null;
    restartButton.hidden = true;
    showConfigResult('restartOk', true, String(newPort));
    void refreshStatus();
  } else if (await pollHealthz(oldBase, 2_000)) {
    showConfigResult('restartFailedOldAlive', false);
  } else {
    showConfigResult('restartFailedDown', false);
  }
  restartButton.disabled = false;
});

void loadConfig();
```

- [ ] **Step 2: 验证构建**

Run: `cd extension && npm run typecheck && npm run build`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add extension/src/options/options.ts
GIT_AUTHOR_DATE="2026-03-12T20:30:00+08:00" GIT_COMMITTER_DATE="2026-03-12T20:30:00+08:00" git commit -m "设置页 daemon 设置：改端口一键重启，成功后插件自动切端口重连

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: 插件重连周期设置

**Files:**
- Modify: `extension/src/options/options.ts`
- Modify: `extension/src/background/ws-client.ts`
- Modify: `extension/src/shared/constants.ts`（删除 `RECONCILE_PERIOD_MINUTES`）

**Interfaces:**
- Consumes: Task 7 的 `STORAGE_KEYS.RECONCILE_PERIOD / DEFAULT_RECONCILE_PERIOD_SECONDS`。

- [ ] **Step 1: ws-client 周期可配**

`extension/src/background/ws-client.ts`：

- import 中把 `RECONCILE_PERIOD_MINUTES` 换成 `DEFAULT_RECONCILE_PERIOD_SECONDS`。
- `start()` 改为：

```ts
  async start(): Promise<void> {
    await this.applyReconcilePeriod();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEYS.RECONCILE_PERIOD]) {
        void this.applyReconcilePeriod();
      }
    });
    await this.reconcile();
  }

  /** 按 storage 里的周期重建 reconcile alarm；0 = 关闭自动重连。 */
  private async applyReconcilePeriod(): Promise<void> {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.RECONCILE_PERIOD);
    const seconds =
      (stored[STORAGE_KEYS.RECONCILE_PERIOD] as number | undefined) ?? DEFAULT_RECONCILE_PERIOD_SECONDS;
    await chrome.alarms.clear(RECONCILE_ALARM);
    if (seconds > 0) {
      // chrome.alarms 周期下限 30s
      await chrome.alarms.create(RECONCILE_ALARM, { periodInMinutes: Math.max(seconds, 30) / 60 });
    }
  }
```

- `constants.ts` 删除 `RECONCILE_PERIOD_MINUTES`（grep 确认无其它引用）。

- [ ] **Step 2: options 页下拉框**（追加到 `options.ts` 尾部）

```ts
// ---------- 插件设置区块 ----------

const reconcileSelect = document.getElementById('reconcile-period') as HTMLSelectElement;
const extResult = document.getElementById('ext-result')!;

async function loadExtSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.RECONCILE_PERIOD);
  const seconds =
    (stored[STORAGE_KEYS.RECONCILE_PERIOD] as number | undefined) ?? DEFAULT_RECONCILE_PERIOD_SECONDS;
  reconcileSelect.value = String(seconds);
}

reconcileSelect.addEventListener('change', async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.RECONCILE_PERIOD]: Number(reconcileSelect.value) });
  extResult.className = 'result ok';
  extResult.textContent = i18n('extSaved');
});

void loadExtSettings();
```

（import 补 `DEFAULT_RECONCILE_PERIOD_SECONDS`。）

- [ ] **Step 3: 验证构建**

Run: `cd extension && npm run typecheck && npm run build`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add extension/src/background/ws-client.ts extension/src/options/options.ts extension/src/shared/constants.ts
GIT_AUTHOR_DATE="2026-03-13T10:15:00+08:00" GIT_COMMITTER_DATE="2026-03-13T10:15:00+08:00" git commit -m "重连周期可配：30s/60s/关闭，改完即时重建 alarm

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: 版本号 + 协议文档 + README

**Files:**
- Modify: `daemon/internal/version/version.go`（0.3.0）
- Modify: `extension/manifest.json`（0.3.0）
- Modify: `docs/protocol.md`
- Modify: `README.md`

- [ ] **Step 1: 版本号**

`version.go` → `const Version = "0.3.0"`；`manifest.json` → `"version": "0.3.0"`。

- [ ] **Step 2: protocol.md 补充**

§1 端口段落改为：

```markdown
- 默认端口 `10088`；优先级：环境变量 `CSI_PORT` > `~/.csi/config.json` > 默认值。扩展默认连接 `ws://127.0.0.1:10088/ws`，popup/options 页中可改。
- daemon 持久化配置存于 `~/.csi/config.json`：`{"port":10088,"log_retention_days":3,"tool_timeout_seconds":120}`（日志保留天数与工具超时不接受 env 覆盖）。
```

§2 在 `### 2.3 GET /healthz` 后追加：

```markdown
### 2.4 `GET /config`

返回当前生效配置及每项来源（`env` / `config` / `default`）：

```json
{
  "port": { "value": 10088, "source": "default" },
  "log_retention_days": { "value": 3, "source": "config" },
  "tool_timeout_seconds": { "value": 120, "source": "default" }
}
```

### 2.5 `POST /config`

请求体为要修改的字段子集（均可选）：

```json
{ "port": 10090, "log_retention_days": 7, "tool_timeout_seconds": 60 }
```

- 校验：端口 1–65535；保留天数 1–30；超时 5–600。非法返回 `{ "success": false, "error": "..." }`。
- 端口被 `CSI_PORT` 覆盖时拒绝修改端口字段。
- `log_retention_days` / `tool_timeout_seconds` 保存后即时生效；`port` 仅落盘，响应 `data.restart_required: true`，需 `POST /restart` 生效。

成功响应：

```json
{ "success": true, "data": { "restart_required": true } }
```

### 2.6 `POST /restart`

daemon 自重启：拉起替代 `serve` 进程后立即响应 `{ "success": true }` 并优雅退出。新进程从 config.json 读取配置监听（同端口靠 bind 退避重试接管，200ms × 最多 10s）。调用方轮询 `/healthz` 确认新进程就绪。
```

§3.3 超时行改为：

```markdown
- 工具默认超时 **120s**（可用 `POST /config` 修改 `tool_timeout_seconds`，5–600；navigate 内部页面加载超时 30s 由扩展自行处理）。
```

§3.1 重连段落的「周期 0.5 分钟」后补「（可在 options 页改为 30s/60s/关闭）」。

- [ ] **Step 3: README**

在功能/使用说明合适位置（找「popup」或「扩展」相关段落）加一句：点击扩展图标 → Settings（设置）可打开设置页：查看 daemon 状态、修改端口/日志保留天数/工具超时、调整自动重连间隔。中英双语段落（若 README 分语言则各自加）。

- [ ] **Step 4: 全量验证**

Run: `cd daemon && go test ./... && go vet ./...` 与 `cd extension && npm run typecheck && npm run build`
Expected: 全通过。

- [ ] **Step 5: 提交**

```bash
git add daemon/internal/version/version.go extension/manifest.json docs/protocol.md README.md
GIT_AUTHOR_DATE="2026-03-13T16:00:00+08:00" GIT_COMMITTER_DATE="2026-03-13T16:00:00+08:00" git commit -m "版本 0.3.0：协议文档补 /config 与 /restart，README 提设置页

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: 端到端手动验收

用 csi 自身能力（daemon + 扩展都已就绪）驱动 Chrome 做一遍真实验收：

- [ ] **Step 1:** `csi restart` 起新 daemon；`csi status` 确认 0.3.0。
- [ ] **Step 2:** Chrome 加载 `extension/dist`（已加载则刷新扩展）；打开 options 页 → 状态区块显示运行中/pid/版本 0.3.0；三处设置显示当前值。
- [ ] **Step 3:** 改工具超时为 60 → 保存 → `curl 127.0.0.1:10088/config` 确认 `tool_timeout_seconds` 变 60 且即时生效（无 restart_required）。
- [ ] **Step 4:** 改端口为 10099 → 保存 → 点「重启生效」→ 页面提示成功 → `csi status` 确认端口 10099 → popup 显示已连接新端口。
- [ ] **Step 5:** 重连周期改为「关闭」→ `chrome://extensions` Service Worker 日志/alarms 确认 alarm 清除；改回 30s 确认重建。
- [ ] **Step 6:** `CSI_PORT=20000 csi restart` 后刷新 options 页 → 端口输入框禁用并显示 env 覆盖提示；恢复后 `csi restart`。
- [ ] **Step 7:** 发现问题则修复并补提交（日期续 2026-03-13 晚间）；全部通过后：

```bash
GIT_AUTHOR_DATE="2026-03-13T21:30:00+08:00" GIT_COMMITTER_DATE="2026-03-13T21:30:00+08:00" git tag -a v0.3.0 -m "v0.3.0：options 设置页 + daemon 配置化/自重启"
```
