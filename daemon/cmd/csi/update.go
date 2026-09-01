// csi update 子命令：检查/下载/校验/替换/优雅重启一条龙,
// 另可选更新技能包(--with-skills)与扩展(--with-extension)。
package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"csi/daemon/internal/daemon"
	"csi/daemon/internal/update"
	"csi/daemon/internal/version"
)

// updateDeps runUpdate 的全部外部依赖,测试逐字段注入。
type updateDeps struct {
	Self       func() (string, error) // 默认 os.Executable
	IsHomebrew func(string) bool
	Check      func(ctx context.Context, force bool) (*update.CheckResult, error)
	Fetch      func(ctx context.Context, tag, goos, goarch string) (string, error)
	Replace    func(self, newBin string) (string, error)
	Running    func() bool  // pid 文件 + /status 身份确认,复用 fetchStatus
	Restart    func() error // 默认走 POST /restart,失败回退进程级 restart
	Out        io.Writer

	// 以下为 --with-skills / --with-extension 用,正常更新路径不触。
	FetchAsset func(ctx context.Context, tag, asset string) ([]byte, error)
	HomeDir    func() (string, error) // 默认 os.UserHomeDir,技能安装目标的基准
}

// runUpdate 执行 csi update 主流程(与 spec C1 一致)。错误一律返回,
// 由 main 写 stderr 并非零退出(--quiet 下定时任务靠日志)。
func runUpdate(args []string, deps updateDeps) error {
	var checkOnly, quiet, withSkills, withExtension bool
	for _, a := range args {
		switch a {
		case "--check":
			checkOnly = true
		case "--quiet":
			quiet = true
		case "--with-skills":
			withSkills = true
		case "--with-extension":
			withExtension = true
		default:
			return fmt.Errorf("unknown flag: %s", a)
		}
	}
	out := deps.Out
	if out == nil {
		out = io.Discard
	}
	// printf 正常路径输出,--quiet 全压
	printf := func(format string, a ...any) {
		if !quiet {
			fmt.Fprintf(out, format+"\n", a...)
		}
	}

	self, err := deps.Self()
	if err != nil {
		return err
	}
	if deps.IsHomebrew != nil && deps.IsHomebrew(self) {
		return fmt.Errorf("csi 是 Homebrew 安装(%s),自更新会覆盖 brew 管理的文件,请运行 brew upgrade csi", self)
	}

	ctx := context.Background()
	res, err := deps.Check(ctx, false)
	if err != nil {
		return err
	}

	if checkOnly {
		// --check 显式要结果,不受 --quiet 压制
		fmt.Fprintf(out, "current: %s\nlatest: %s\nupdate_available: %t\n",
			version.Version, res.LatestVersion, update.NewerAvailable(version.Version, res.LatestVersion))
		return nil
	}

	if !update.NewerAvailable(version.Version, res.LatestVersion) {
		printf("csi is already up to date (%s)", version.Version)
		return nil
	}

	printf("updating csi %s -> %s ...", version.Version, res.LatestVersion)
	bin, err := deps.Fetch(ctx, res.Tag, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return fmt.Errorf("下载新版本失败: %w", err)
	}
	backup, err := deps.Replace(self, bin)
	if err != nil {
		return err
	}
	if backup != "" {
		printf("旧版本已备份到 %s", backup)
	}
	printf("csi updated to %s", res.LatestVersion)

	if deps.Running() {
		if err := deps.Restart(); err != nil {
			return fmt.Errorf("二进制已替换,但 daemon 重启失败(可手动 csi restart): %w", err)
		}
		printf("daemon restarted")
	} else {
		printf("daemon 未在运行,新版本将在下次 csi start 时生效")
	}

	if withSkills {
		if err := updateSkills(ctx, deps, res.Tag, printf); err != nil {
			return err
		}
	}
	if withExtension {
		if err := updateExtension(ctx, deps, res.Tag, printf); err != nil {
			return err
		}
	}
	return nil
}

// cmdUpdate 是 csi update 的薄壳:装配真实依赖后转 runUpdate。
func cmdUpdate() error {
	dir, err := daemon.EnsureRunDir()
	if err != nil {
		return err
	}
	checker := &update.Checker{Dir: dir}
	return runUpdate(os.Args[2:], updateDeps{
		Self:       os.Executable,
		IsHomebrew: update.IsHomebrewInstall,
		Check:      checker.Check,
		Fetch:      checker.Fetch,
		Replace:    update.Replace,
		Running:    daemonRunning,
		Restart:    restartDaemon,
		Out:        os.Stdout,
		FetchAsset: func(ctx context.Context, tag, asset string) ([]byte, error) {
			return fetchReleaseAsset(ctx, checker.Releases, checker.Client, tag, asset)
		},
		HomeDir: os.UserHomeDir,
	})
}

// daemonRunning 判定 daemon 活着且是 csi:读 pid 文件 + /status 身份确认
// (与 decideStart 同一语义:仅进程活着且 pid 匹配才算 running)。
func daemonRunning() bool {
	dir, err := daemon.RunDir()
	if err != nil {
		return false
	}
	pid, err := daemon.ReadPID(dir)
	if err != nil || !daemon.PIDAlive(pid) {
		return false
	}
	st, err := fetchStatus(daemon.Port())
	return err == nil && st != nil && st.PID == pid
}

// restartDaemon 优先走 HTTP POST /restart(优雅:新进程拉起、旧进程等端口释放);
// 不可达、非 200 或 body success:false 时回退进程级 restart(stop+start,同 cmdRestart)。
func restartDaemon() error {
	return restartDaemonHTTP(daemon.Port(), cmdRestart)
}

// restartDaemonHTTP POST 127.0.0.1:<port>/restart 并解析响应。
// 本项目约定业务错误走 body(writeJSON 恒 200):success:false 时
// 重启实际失败(如 spawn 替代进程出错),必须回退 fallback。
func restartDaemonHTTP(port int, fallback func() error) error {
	client := &http.Client{Timeout: 5 * time.Second}
	url := fmt.Sprintf("http://127.0.0.1:%d/restart", port)
	resp, err := client.Post(url, "", nil)
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			err = fmt.Errorf("HTTP %d", resp.StatusCode)
		} else {
			var body struct {
				Success bool   `json:"success"`
				Error   string `json:"error"`
			}
			if decErr := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); decErr != nil {
				err = fmt.Errorf("解析 /restart 响应失败: %w", decErr)
			} else if !body.Success {
				err = fmt.Errorf("/restart 返回失败: %s", body.Error)
			}
		}
	}
	if err == nil {
		return nil
	}
	fmt.Printf("POST /restart 失败(%v),回退进程级 restart\n", err)
	return fallback()
}

// updateSkills 下载 csi-skill.tar.gz / csi-e2e-skill.tar.gz 解到
// ~/.claude/skills/(与 install.sh 同布局,归档根名即技能目录名)。
// 覆盖已存在的技能目录前打印警告。
func updateSkills(ctx context.Context, deps updateDeps, tag string, printf func(string, ...any)) error {
	home, err := deps.HomeDir()
	if err != nil {
		return err
	}
	base := filepath.Join(home, ".claude", "skills")
	for _, skill := range []struct{ asset, dir string }{
		{"csi-skill.tar.gz", "csi"},
		{"csi-e2e-skill.tar.gz", "csi-e2e"},
	} {
		data, err := deps.FetchAsset(ctx, tag, skill.asset)
		if err != nil {
			return fmt.Errorf("下载 %s 失败: %w", skill.asset, err)
		}
		target := filepath.Join(base, skill.dir)
		if _, err := os.Stat(target); err == nil {
			printf("warning: 覆盖已存在的技能目录 %s", target)
			if err := os.RemoveAll(target); err != nil {
				return err
			}
		}
		if err := os.MkdirAll(base, 0o755); err != nil {
			return err
		}
		if err := extractTarGzBytes(data, base); err != nil {
			return fmt.Errorf("解压 %s 失败: %w", skill.asset, err)
		}
		printf("skill %s -> %s", skill.dir, target)
	}
	return nil
}

// updateExtension 下载 csi-extension.zip 解到 ~/.csi/extension(整体替换),
// 并提示到 chrome://extensions 点 reload。
func updateExtension(ctx context.Context, deps updateDeps, tag string, printf func(string, ...any)) error {
	dir, err := daemon.RunDir()
	if err != nil {
		return err
	}
	extDir := filepath.Join(dir, "extension")
	data, err := deps.FetchAsset(ctx, tag, "csi-extension.zip")
	if err != nil {
		return fmt.Errorf("下载 csi-extension.zip 失败: %w", err)
	}
	if err := os.RemoveAll(extDir); err != nil {
		return err
	}
	if err := os.MkdirAll(extDir, 0o755); err != nil {
		return err
	}
	if err := extractZipBytes(data, extDir); err != nil {
		return fmt.Errorf("解压 csi-extension.zip 失败: %w", err)
	}
	printf("extension updated at %s", extDir)
	printf("到 chrome://extensions 点 reload 加载新扩展")
	return nil
}

// fetchReleaseAsset 下载 <Releases>/download/<tag>/<asset> 并用同目录
// checksums.txt 校验 sha256。update.Checker 的 asset 下载未导出(只服务
// 二进制包白名单),技能/扩展包在这里自办,校验强度与 Fetch 对齐。
func fetchReleaseAsset(ctx context.Context, releases string, client *http.Client, tag, asset string) ([]byte, error) {
	if releases == "" {
		releases = update.DefaultReleases
	}
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Minute}
	}
	base := strings.TrimSuffix(releases, "/") + "/download/" + tag

	sums, err := httpGetBytes(ctx, client, base+"/checksums.txt")
	if err != nil {
		return nil, fmt.Errorf("下载 checksums.txt 失败: %w", err)
	}
	want, err := findAssetChecksum(sums, asset)
	if err != nil {
		return nil, err
	}
	data, err := httpGetBytes(ctx, client, base+"/"+asset)
	if err != nil {
		return nil, err
	}
	if sum := sha256.Sum256(data); fmt.Sprintf("%x", sum) != want {
		return nil, fmt.Errorf("sha256 校验失败: %s 期望 %s 实际 %x", asset, want, sum)
	}
	return data, nil
}

// httpGetBytes 发起一次 GET 并读全响应体;非 200 视为错误。
func httpGetBytes(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "csi-daemon")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// findAssetChecksum 在 sha256sum 格式的 checksums.txt 内容里找 asset 的期望哈希。
func findAssetChecksum(sums []byte, asset string) (string, error) {
	for _, line := range strings.Split(string(sums), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[1] == asset {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("checksums.txt 中找不到 %s", asset)
}

// extractTarGzBytes 把 tar.gz 内容解到 destDir(保留归档内相对路径)。
func extractTarGzBytes(data []byte, destDir string) error {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		dst, err := safeJoin(destDir, hdr.Name)
		if err != nil {
			return err
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return err
			}
			if err := writeExtractedFile(tr, dst); err != nil {
				return err
			}
		}
	}
}

// extractZipBytes 把 zip 内容解到 destDir(保留归档内相对路径)。
func extractZipBytes(data []byte, destDir string) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	for _, zf := range zr.File {
		dst, err := safeJoin(destDir, zf.Name)
		if err != nil {
			return err
		}
		if zf.FileInfo().IsDir() {
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return err
			}
			continue
		}
		rc, err := zf.Open()
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			rc.Close()
			return err
		}
		err = writeExtractedFile(rc, dst)
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// safeJoin 把归档内路径安全地拼到 destDir 下,拒绝绝对路径与 .. 逃逸。
func safeJoin(destDir, name string) (string, error) {
	clean := filepath.Clean(name)
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("归档包含非法路径: %s", name)
	}
	return filepath.Join(destDir, clean), nil
}

// writeExtractedFile 把归档成员内容写到 dst,权限 0644。
func writeExtractedFile(r io.Reader, dst string) error {
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, r)
	return err
}
