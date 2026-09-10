// config.json：daemon 的持久化配置（~/.csi/config.json）。
// 端口优先级：CSI_PORT 环境变量 > config.json > 默认值；
// 监听地址优先级：CSI_HOST 环境变量 > config.json > 默认值；
// 日志保留天数、工具超时与鉴权项只走 config.json，不接受 env 覆盖。
package daemon

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
)

// 配置项校验边界（协议 §2.4/§2.7）。
const (
	MinPort, MaxPort                     = 1, 65535
	MinKeepDays, MaxKeepDays             = 1, 30
	MinToolTimeoutSec, MaxToolTimeoutSec = 5, 600
	MinAPIKeyLen, MaxAPIKeyLen           = 16, 128
	DefaultKeepDays                      = 3
	DefaultToolTimeoutSec                = 120
	DefaultBindHost                      = "127.0.0.1"
)

// Config config.json 的全部字段。
type Config struct {
	Port               int    `json:"port"`
	BindHost           string `json:"bind_host"`
	LogRetentionDays   int    `json:"log_retention_days"`
	ToolTimeoutSeconds int    `json:"tool_timeout_seconds"`
	AuthEnabled        bool   `json:"auth_enabled"`
	APIKey             string `json:"api_key"`
}

// DefaultConfig 各字段默认值。
func DefaultConfig() Config {
	return Config{
		Port:               DefaultPort,
		BindHost:           DefaultBindHost,
		LogRetentionDays:   DefaultKeepDays,
		ToolTimeoutSeconds: DefaultToolTimeoutSec,
		AuthEnabled:        false,
		APIKey:             "",
	}
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

// AuthRequired 鉴权是否生效（协议 §2.7）：auth_enabled 且 api_key 非空。
// auth_enabled:true 但 key 空/非法（手改 config.json）时视为未开启——
// fail-open 防锁死，用户直接编辑 ~/.csi/config.json 即可恢复。
// server 鉴权中间件、/ws 握手与 CLI 警告共用此判定。
func (rc *ResolvedConfig) AuthRequired() bool {
	return rc.Values.AuthEnabled && rc.Values.APIKey != ""
}

// configFields ResolvedConfig.Sources 的合法 key。
var configFields = []string{"port", "bind_host", "log_retention_days", "tool_timeout_seconds", "auth_enabled", "api_key"}

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

// ValidateBindHost 校验监听地址（协议 §2.5）：只接受 IP 字面量（IPv4/IPv6）。
// 0.0.0.0 = 全部网卡（含回环）；具体网卡 IP = 仅该地址（失去回环）；:: = IPv6 全网卡。
func ValidateBindHost(host string) error {
	if net.ParseIP(host) == nil {
		return fmt.Errorf("bind_host must be an IP literal (e.g. 127.0.0.1, 0.0.0.0, 192.168.1.10, ::)")
	}
	return nil
}

// ValidateAPIKey 校验鉴权 key（协议 §2.5）：长度 16–128，
// 全部为可打印 ASCII（0x21–0x7E，不含空白）。
func ValidateAPIKey(key string) error {
	if len(key) < MinAPIKeyLen || len(key) > MaxAPIKeyLen {
		return fmt.Errorf("api_key must be %d-%d characters", MinAPIKeyLen, MaxAPIKeyLen)
	}
	for i := 0; i < len(key); i++ {
		if key[i] < 0x21 || key[i] > 0x7E {
			return fmt.Errorf("api_key must be printable ASCII without whitespace")
		}
	}
	return nil
}

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
			// 空串 = 未设置，维持默认；非法值同样回退默认。
			if file.BindHost != "" && ValidateBindHost(file.BindHost) == nil {
				rc.Values.BindHost = file.BindHost
				rc.Sources["bind_host"] = SourceConfig
			}
			if ValidateField("log_retention_days", file.LogRetentionDays) == nil {
				rc.Values.LogRetentionDays = file.LogRetentionDays
				rc.Sources["log_retention_days"] = SourceConfig
			}
			if ValidateField("tool_timeout_seconds", file.ToolTimeoutSeconds) == nil {
				rc.Values.ToolTimeoutSeconds = file.ToolTimeoutSeconds
				rc.Sources["tool_timeout_seconds"] = SourceConfig
			}
			// 鉴权项只走 config.json（无 env 覆盖）；key 空串 = 未设置。
			// auth_enabled:true 但 key 空/非法时 LoadConfig 照采信开关，
			// 由 AuthRequired() 的 fail-open 判定兜底（协议 §2.7）。
			// bool 零值与「字段不存在」不可分辨，用 raw map 检测字段真实存在
			// 才把 source 标为 config（旧文件缺字段时维持 default）。
			var raw map[string]json.RawMessage
			if json.Unmarshal(data, &raw) == nil {
				if _, ok := raw["auth_enabled"]; ok {
					rc.Values.AuthEnabled = file.AuthEnabled
					rc.Sources["auth_enabled"] = SourceConfig
				}
				if _, ok := raw["api_key"]; ok {
					if file.APIKey != "" && ValidateAPIKey(file.APIKey) == nil {
						rc.Values.APIKey = file.APIKey
						rc.Sources["api_key"] = SourceConfig
					}
				}
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
	// CSI_HOST 只覆盖监听地址（与 CSI_PORT 同语义的临时覆盖手段）。
	if v := os.Getenv("CSI_HOST"); v != "" && ValidateBindHost(v) == nil {
		rc.Values.BindHost = v
		rc.Sources["bind_host"] = SourceEnv
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

// DiskBindHost 返回 config.json 中落盘的监听地址（不叠加 CSI_HOST 覆盖）；
// 文件缺失 / 解析失败 / 值非法时返回默认值。用于 env 锁定监听地址时
// 保存配置，不把临时的 env 覆盖固化进文件（与 DiskPort 同语义）。
func DiskBindHost(dir string) string {
	data, err := os.ReadFile(configPath(dir))
	if err != nil {
		return DefaultBindHost
	}
	var file Config
	if json.Unmarshal(data, &file) != nil || file.BindHost == "" || ValidateBindHost(file.BindHost) != nil {
		return DefaultBindHost
	}
	return file.BindHost
}

// SaveConfig 全量写 config.json。权限 0600（协议 §2.7）：文件含 api_key。
// 已存在的旧文件（0644）在首次保存后自然收敛到 0600。
func SaveConfig(dir string, cfg Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(dir), data, 0o600)
}
