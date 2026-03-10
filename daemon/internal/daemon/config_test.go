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
