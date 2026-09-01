package update

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// assetName 返回 release 资产白名单(与 release.yml 矩阵一一对应)内
// 该平台的包名;矩阵外组合报错,不支持的机器不会发出任何请求。
func assetName(goos, goarch string) (string, error) {
	switch goos + "/" + goarch {
	case "darwin/arm64", "darwin/amd64", "linux/arm64", "linux/amd64":
		return fmt.Sprintf("csi-%s-%s.tar.gz", goos, goarch), nil
	case "windows/amd64":
		return "csi-windows-amd64.zip", nil
	default:
		return "", fmt.Errorf("不支持的平台: %s/%s", goos, goarch)
	}
}

// Fetch 下载 <Releases>/download/<tag>/ 下对应平台的 daemon 包与 checksums.txt,
// 校验 sha256 后解出二进制,返回临时文件路径(调用方负责清理或消费)。
// 任何一步失败都不产出二进制。
func (c *Checker) Fetch(ctx context.Context, tag, goos, goarch string) (binPath string, err error) {
	asset, err := assetName(goos, goarch)
	if err != nil {
		return "", err
	}
	releases := c.Releases
	if releases == "" {
		releases = DefaultReleases
	}
	base := strings.TrimSuffix(releases, "/") + "/download/" + tag

	// 先 checksums.txt 后 asset:拿不到期望值就不浪费带宽下大包
	sums, err := c.download(ctx, base+"/checksums.txt")
	if err != nil {
		return "", fmt.Errorf("下载 checksums.txt 失败: %w", err)
	}
	want, err := findChecksum(sums, asset)
	if err != nil {
		return "", err
	}

	// 落到独立临时目录,出错时整体清理,保证不产出半成品
	tmpDir, err := os.MkdirTemp("", "csi-update-*")
	if err != nil {
		return "", err
	}
	defer func() {
		if err != nil {
			os.RemoveAll(tmpDir)
		}
	}()

	archivePath := filepath.Join(tmpDir, asset)
	data, err := c.download(ctx, base+"/"+asset)
	if err != nil {
		return "", fmt.Errorf("下载 %s 失败: %w", asset, err)
	}
	sum := sha256.Sum256(data)
	if fmt.Sprintf("%x", sum) != want {
		return "", fmt.Errorf("sha256 校验失败: %s 期望 %s 实际 %x", asset, want, sum)
	}
	if err := os.WriteFile(archivePath, data, 0o644); err != nil {
		return "", err
	}

	// tar.gz 取成员 csi,zip 取 csi.exe
	member := "csi"
	if strings.HasSuffix(asset, ".zip") {
		member = "csi.exe"
	}
	binPath = filepath.Join(tmpDir, member)
	if strings.HasSuffix(asset, ".zip") {
		err = extractZip(archivePath, member, binPath)
	} else {
		err = extractTarGz(archivePath, member, binPath)
	}
	if err != nil {
		return "", err
	}
	if err := os.Chmod(binPath, 0o755); err != nil {
		return "", err
	}
	return binPath, nil
}

// download 发起一次 GET 并读全响应体;非 200 视为错误。
func (c *Checker) download(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "csi-daemon")
	resp, err := c.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// findChecksum 在 sha256sum 格式的 checksums.txt 内容里找 asset 对应的期望哈希。
func findChecksum(sums []byte, asset string) (string, error) {
	for _, line := range strings.Split(string(sums), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[1] == asset {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("checksums.txt 中找不到 %s", asset)
}

// extractTarGz 从 tar.gz 中取出名为 member 的成员写到 dst。
func extractTarGz(archivePath, member, dst string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if filepath.Base(hdr.Name) == member {
			return writeMember(tr, dst)
		}
	}
	return fmt.Errorf("归档中找不到成员 %s", member)
}

// extractZip 从 zip 中取出名为 member 的成员写到 dst。
func extractZip(archivePath, member, dst string) error {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, zf := range zr.File {
		if filepath.Base(zf.Name) == member {
			rc, err := zf.Open()
			if err != nil {
				return err
			}
			defer rc.Close()
			return writeMember(rc, dst)
		}
	}
	return fmt.Errorf("归档中找不到成员 %s", member)
}

// writeMember 把归档成员内容写到 dst,权限 0755。
func writeMember(r io.Reader, dst string) error {
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, r)
	return err
}

// Replace 用 newBin 替换 self(当前可执行文件),返回备份路径。
// unix:rename 现行为 <self>.bak(只留一代),再 rename 新文件就位;
// windows:先 rename 现行为 <self>.old 再落新文件(Windows 不能覆盖
// 运行中的 exe,但允许 rename)。
func Replace(self, newBin string) (backupPath string, err error) {
	if runtime.GOOS == "windows" {
		return replaceWindows(self, newBin)
	}
	return replaceUnix(self, newBin)
}

// replaceUnix:rename 现行为 .bak(rename 会覆盖旧 .bak,天然只留一代),
// 再 rename 新文件就位。Fetch 落在系统临时目录,与目标可能不同盘,
// 跨设备 rename(EXDEV)必失败,fallback 到 io copy。
func replaceUnix(self, newBin string) (string, error) {
	backupPath := self + ".bak"
	if err := os.Rename(self, backupPath); err != nil {
		// 备份失败不致命:self 可能本就不存在(首次安装)
		backupPath = ""
	}
	if err := os.Rename(newBin, self); err != nil {
		if err := copyFile(newBin, self); err != nil {
			return "", fmt.Errorf("替换 %s 失败: %w", self, err)
		}
	}
	if err := os.Chmod(self, 0o755); err != nil {
		return "", err
	}
	return backupPath, nil
}

// replaceWindows:Windows 不允许覆盖正在运行的 exe,但允许 rename。
// 先把现行 exe rename 成 .old,再把新文件 copy 就位。
// .old 轮换:rename 前 best-effort 删旧 .old;删不掉(旧 daemon 还跑着,
// 文件被锁)就退而用带时间戳的 .old.<unixMilli>,容忍多代并存。
func replaceWindows(self, newBin string) (string, error) {
	oldPath := self + ".old"
	if err := os.Remove(oldPath); err != nil && !os.IsNotExist(err) {
		// 旧 .old 删不掉,改用时间戳名
		oldPath = fmt.Sprintf("%s.old.%d", self, time.Now().UnixMilli())
	}
	if _, err := os.Stat(self); err == nil {
		if err := os.Rename(self, oldPath); err != nil {
			return "", fmt.Errorf("备份现行 exe 失败: %w", err)
		}
	} else {
		oldPath = ""
	}
	if err := copyFile(newBin, self); err != nil {
		return "", fmt.Errorf("替换 %s 失败: %w", self, err)
	}
	return oldPath, nil
}

// copyFile 把 src 内容复制到 dst(覆盖写),权限 0755。
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// IsHomebrewInstall 判断二进制是否 Homebrew 安装(Cellar/homebrew/linuxbrew 路径)。
// Homebrew 安装的 daemon 不能用自更新覆盖,得走 brew upgrade。
func IsHomebrewInstall(self string) bool {
	lower := strings.ToLower(self)
	return strings.Contains(lower, "/cellar/") ||
		strings.Contains(lower, "/homebrew/") ||
		strings.Contains(lower, "/linuxbrew/")
}
