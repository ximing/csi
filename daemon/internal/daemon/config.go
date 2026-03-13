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
	MinPort, MaxPort                     = 1, 65535
	MinKeepDays, MaxKeepDays             = 1, 30
	MinToolTimeoutSec, MaxToolTimeoutSec = 5, 600
	DefaultKeepDays                      = 3
	DefaultToolTimeoutSec                = 120
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

// DiskPort 返回 config.json 中落盘的端口（不叠加 CSI_PORT 覆盖）；
// 文件缺失 / 解析失败 / 值非法时返回默认端口。用于 env 锁定端口时
// 保存配置，不把临时的 env 覆盖固化进文件。
func DiskPort(dir string) int {
	data, err := os.ReadFile(configPath(dir))
	if err != nil {
		return DefaultPort
	}
	var file Config
	if json.Unmarshal(data, &file) != nil || ValidateField("port", file.Port) != nil {
		return DefaultPort
	}
	return file.Port
}

// SaveConfig 全量写 config.json。
func SaveConfig(dir string, cfg Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(dir), data, 0o644)
}
