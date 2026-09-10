package daemon

import (
	"os"
	"path/filepath"
	"strings"
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
	for _, f := range []string{"port", "bind_host", "log_retention_days", "tool_timeout_seconds"} {
		if rc.Sources[f] != SourceDefault {
			t.Fatalf("Sources[%q] = %q, want default", f, rc.Sources[f])
		}
	}
}

// Save 后 Load 回读；来源变 config。
func TestSaveAndLoadConfig(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	want := Config{Port: 10090, BindHost: "0.0.0.0", LogRetentionDays: 7, ToolTimeoutSeconds: 60}
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
	if rc.Sources["bind_host"] != SourceConfig {
		t.Fatalf("Sources[bind_host] = %q, want config", rc.Sources["bind_host"])
	}
}

// 非法字段按默认值补齐，合法字段保留。
func TestLoadConfigInvalidFields(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	data := []byte(`{"port": 0, "bind_host": "localhost", "log_retention_days": 99, "tool_timeout_seconds": 60}`)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	rc, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	want := Config{Port: DefaultPort, BindHost: DefaultBindHost, LogRetentionDays: 3, ToolTimeoutSeconds: 60}
	if rc.Values != want {
		t.Fatalf("Values = %+v, want %+v", rc.Values, want)
	}
	if rc.Sources["port"] != SourceDefault || rc.Sources["bind_host"] != SourceDefault || rc.Sources["log_retention_days"] != SourceDefault {
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

// CSI_HOST 覆盖 config 文件，来源为 env；非法值忽略。
func TestLoadConfigBindHostEnvOverride(t *testing.T) {
	dir := t.TempDir()
	if err := SaveConfig(dir, Config{Port: 10090, BindHost: "192.168.1.10", LogRetentionDays: 3, ToolTimeoutSeconds: 120}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CSI_HOST", "0.0.0.0")
	rc, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if rc.Values.BindHost != "0.0.0.0" || rc.Sources["bind_host"] != SourceEnv {
		t.Fatalf("bind_host = %q (%s), want 0.0.0.0 (env)", rc.Values.BindHost, rc.Sources["bind_host"])
	}
	t.Setenv("CSI_HOST", "not-an-ip")
	rc, err = LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if rc.Values.BindHost != "192.168.1.10" || rc.Sources["bind_host"] != SourceConfig {
		t.Fatalf("invalid CSI_HOST should be ignored, got %q (%s)", rc.Values.BindHost, rc.Sources["bind_host"])
	}
}

// ValidateBindHost：只接受 IP 字面量。
func TestValidateBindHost(t *testing.T) {
	t.Parallel()
	cases := []struct {
		host string
		ok   bool
	}{
		{"127.0.0.1", true}, {"0.0.0.0", true}, {"192.168.1.10", true},
		{"::", true}, {"::1", true}, {"fe80::1", true},
		{"", false}, {"localhost", false}, {"csi.local", false}, {"127.0.0.1:8080", false},
	}
	for _, c := range cases {
		err := ValidateBindHost(c.host)
		if c.ok != (err == nil) {
			t.Fatalf("ValidateBindHost(%q) err = %v, want ok=%v", c.host, err, c.ok)
		}
	}
}

// DiskBindHost：磁盘原值，不叠加 env；缺失/非法回默认。
func TestDiskBindHost(t *testing.T) {
	dir := t.TempDir()
	if got := DiskBindHost(dir); got != DefaultBindHost {
		t.Fatalf("no config: DiskBindHost = %q, want %q", got, DefaultBindHost)
	}
	if err := SaveConfig(dir, Config{Port: 10090, BindHost: "0.0.0.0", LogRetentionDays: 3, ToolTimeoutSeconds: 120}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CSI_HOST", "127.0.0.1") // env 不影响磁盘原值
	if got := DiskBindHost(dir); got != "0.0.0.0" {
		t.Fatalf("DiskBindHost = %q, want 0.0.0.0", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"bind_host": "bogus"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := DiskBindHost(dir); got != DefaultBindHost {
		t.Fatalf("invalid disk value: DiskBindHost = %q, want %q", got, DefaultBindHost)
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

// ValidateAPIKey：长度 16–128、可打印 ASCII 无空白（协议 §2.5）。
func TestValidateAPIKey(t *testing.T) {
	t.Parallel()
	cases := []struct {
		key string
		ok  bool
	}{
		{"csi-key-0123456789", true}, // 18 字符
		{strings.Repeat("a", 15), false},
		{strings.Repeat("a", 16), true},
		{strings.Repeat("a", 128), true},
		{strings.Repeat("a", 129), false},
		{"csi key 0123456789", false}, // 含空格
		{"csi\tkey-012345678", false}, // 含 tab
		{"csi-key-01234567\n", false}, // 含换行
		{"", false},
	}
	for _, c := range cases {
		err := ValidateAPIKey(c.key)
		if c.ok != (err == nil) {
			t.Fatalf("ValidateAPIKey(%q) err = %v, want ok=%v", c.key, err, c.ok)
		}
	}
}

// 鉴权项 Load：合法 key 采信；非法 key 回退空且 AuthRequired 兜底为 false；
// 旧文件缺 auth_enabled 字段时来源维持 default（bool 零值与缺字段不可分辨）。
func TestLoadConfigAuth(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	// 旧版 config（无鉴权字段）：来源 default、AuthRequired false。
	old := []byte(`{"port": 10088, "log_retention_days": 3, "tool_timeout_seconds": 120}`)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), old, 0o644); err != nil {
		t.Fatal(err)
	}
	rc, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if rc.Sources["auth_enabled"] != SourceDefault || rc.Sources["api_key"] != SourceDefault {
		t.Fatalf("old config without auth fields should stay default, got %+v", rc.Sources)
	}
	if rc.AuthRequired() {
		t.Fatal("AuthRequired should be false by default")
	}

	// 合法 key + 开关：采信，AuthRequired true。
	cfg := Config{Port: 10088, LogRetentionDays: 3, ToolTimeoutSeconds: 120,
		AuthEnabled: true, APIKey: "csi-key-0123456789"}
	if err := SaveConfig(dir, cfg); err != nil {
		t.Fatal(err)
	}
	rc, err = LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if !rc.Values.AuthEnabled || rc.Values.APIKey != cfg.APIKey {
		t.Fatalf("auth values not loaded: %+v", rc.Values)
	}
	if rc.Sources["auth_enabled"] != SourceConfig || rc.Sources["api_key"] != SourceConfig {
		t.Fatalf("Sources want config, got %+v", rc.Sources)
	}
	if !rc.AuthRequired() {
		t.Fatal("AuthRequired should be true")
	}

	// 非法 key（含空格）+ 开关 true：key 回退空，fail-open → AuthRequired false（协议 §2.7）。
	bad := []byte(`{"port": 10088, "auth_enabled": true, "api_key": "has space in it 123"}`)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), bad, 0o644); err != nil {
		t.Fatal(err)
	}
	rc, err = LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if rc.Values.APIKey != "" {
		t.Fatalf("invalid api_key should fall back to empty, got %q", rc.Values.APIKey)
	}
	if rc.AuthRequired() {
		t.Fatal("fail-open: auth_enabled with invalid key must not require auth")
	}
}

// SaveConfig 落盘权限 0600（协议 §2.7，文件含 api_key）。
func TestSaveConfigFileMode(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	if err := SaveConfig(dir, DefaultConfig()); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config.json mode = %o, want 600", perm)
	}
}

// EffectiveAPIKey：读 config.json 的 api_key；未配置 / 无文件返回空。
func TestEffectiveAPIKey(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CSI_HOME", dir)
	if got := EffectiveAPIKey(); got != "" {
		t.Fatalf("no config: EffectiveAPIKey = %q, want empty", got)
	}
	if err := SaveConfig(dir, Config{Port: 10088, LogRetentionDays: 3, ToolTimeoutSeconds: 120,
		AuthEnabled: true, APIKey: "csi-key-0123456789"}); err != nil {
		t.Fatal(err)
	}
	if got := EffectiveAPIKey(); got != "csi-key-0123456789" {
		t.Fatalf("EffectiveAPIKey = %q, want configured key", got)
	}
}
