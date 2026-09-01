// Package update 提供 GitHub latest release 查询与本地缓存,
// 供 `csi update` 子命令和 /status 端点判断是否有新版本。
package update

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// 缓存 TTL:24h 内不重复打 GitHub API。
const CacheTTL = 24 * time.Hour

// 默认端点常量,可被 Checker 字段覆盖(测试注入)。
const (
	DefaultAPIURL   = "https://api.github.com/repos/ximing/csi/releases/latest"
	DefaultReleases = "https://github.com/ximing/csi/releases"
)

// cacheFileName 是 Dir 下的缓存文件名。
const cacheFileName = "update-check.json"

// CheckResult 是一次 latest 检查的结果,也是缓存文件的 JSON 结构。
type CheckResult struct {
	LatestVersion string    `json:"latest_version"` // 去 v 前缀,如 "0.8.0"
	Tag           string    `json:"tag"`            // 如 "v0.8.0"
	CheckedAt     time.Time `json:"checked_at"`
}

// Checker 查询 GitHub latest release 并缓存到 <Dir>/update-check.json(TTL 24h)。
type Checker struct {
	Dir      string           // ~/.csi
	APIURL   string           // 默认 DefaultAPIURL,测试注入
	Releases string           // 下载基址,默认 DefaultReleases
	Client   *http.Client     // nil → 10s 超时的默认 client
	Now      func() time.Time // nil → time.Now
}

func (c *Checker) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Checker) client() *http.Client {
	if c.Client != nil {
		return c.Client
	}
	return &http.Client{Timeout: 10 * time.Second}
}

func (c *Checker) apiURL() string {
	if c.APIURL != "" {
		return c.APIURL
	}
	return DefaultAPIURL
}

// Check 返回 latest 版本。缓存新鲜(24h)且不 force 时直接读缓存;
// 否则请求 API 并写缓存。API 失败但有过期缓存时返回过期缓存且不报错
// (离线不打扰);无缓存才返回 error。
func (c *Checker) Check(ctx context.Context, force bool) (*CheckResult, error) {
	if !force {
		if cached := c.ReadCache(); cached != nil && c.now().Sub(cached.CheckedAt) < CacheTTL {
			return cached, nil
		}
	}

	result, err := c.fetch(ctx)
	if err != nil {
		// API 挂了:有过期缓存就悄悄用它
		if cached := c.ReadCache(); cached != nil {
			return cached, nil
		}
		return nil, err
	}
	if err := c.writeCache(result); err != nil {
		// 缓存写失败不影响结果本身
		return result, nil
	}
	return result, nil
}

// ReadCache 读取缓存,无缓存或内容损坏返回 nil。
func (c *Checker) ReadCache() *CheckResult {
	data, err := os.ReadFile(filepath.Join(c.Dir, cacheFileName))
	if err != nil {
		return nil
	}
	var r CheckResult
	if err := json.Unmarshal(data, &r); err != nil {
		return nil
	}
	return &r
}

// fetch 请求 GitHub latest release API 并解析 tag_name。
func (c *Checker) fetch(ctx context.Context) (*CheckResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.apiURL(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "csi-daemon")

	resp, err := c.client().Do(req)
	if err != nil {
		return nil, fmt.Errorf("查询 latest release 失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("查询 latest release 失败: HTTP %d", resp.StatusCode)
	}

	var body struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("解析 latest release 响应失败: %w", err)
	}
	if body.TagName == "" {
		return nil, fmt.Errorf("latest release 响应缺少 tag_name")
	}

	return &CheckResult{
		LatestVersion: strings.TrimPrefix(body.TagName, "v"),
		Tag:           body.TagName,
		CheckedAt:     c.now(),
	}, nil
}

// writeCache 原子写缓存:先写 tmp 再 rename,避免崩溃留下半个文件。
func (c *Checker) writeCache(r *CheckResult) error {
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	path := filepath.Join(c.Dir, cacheFileName)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// NewerAvailable 比较 semver x.y.z:latest 是否比 current 新。
// 段数不足补 0;任何一段非数字 → false。
func NewerAvailable(current, latest string) bool {
	cur := strings.Split(current, ".")
	lat := strings.Split(latest, ".")
	n := len(cur)
	if len(lat) > n {
		n = len(lat)
	}
	for i := 0; i < n; i++ {
		ci, ok := segmentAt(cur, i)
		if !ok {
			return false
		}
		li, ok := segmentAt(lat, i)
		if !ok {
			return false
		}
		if li != ci {
			return li > ci
		}
	}
	return false
}

// segmentAt 取第 i 段并转 int;段不存在补 0,非数字返回 false。
func segmentAt(parts []string, i int) (int, bool) {
	if i >= len(parts) {
		return 0, true
	}
	v, err := strconv.Atoi(parts[i])
	if err != nil {
		return 0, false
	}
	return v, true
}
