package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// buildTarGz 构造一个内含单个成员(名为 name)的 tar.gz 字节流。
func buildTarGz(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(content))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// buildZip 构造一个内含单个成员(名为 name)的 zip 字节流。
func buildZip(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// checksumLine 按 sha256sum 输出格式("<hex>  <name>")生成一行。
func checksumLine(name string, data []byte) string {
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%x  %s\n", sum, name)
}

// releaseServer 伺服 <base>/download/<tag>/ 下的 asset 与 checksums.txt。
// assets 为文件名到内容的映射;checksums 若为 nil 则由 assets 自动算出。
// 返回 server 与记录到的请求路径(线程安全)。
func releaseServer(t *testing.T, assets map[string][]byte, checksums []byte) (*httptest.Server, func() []string) {
	t.Helper()
	if checksums == nil {
		var sb strings.Builder
		for name, data := range assets {
			sb.WriteString(checksumLine(name, data))
		}
		checksums = []byte(sb.String())
	}
	var mu sync.Mutex
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		name := filepath.Base(r.URL.Path)
		if name == "checksums.txt" {
			w.Write(checksums)
			return
		}
		if data, ok := assets[name]; ok {
			w.Write(data)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), paths...)
	}
}

func TestFetchVerifiesChecksum(t *testing.T) {
	binContent := []byte("#!/bin/sh\necho fake csi\n")
	asset := "csi-darwin-arm64.tar.gz"
	assets := map[string][]byte{asset: buildTarGz(t, "csi", binContent)}

	// 1) checksum 匹配 → 返回的二进制可读,内容与打包内容一致
	srv, _ := releaseServer(t, assets, nil)
	c := &Checker{Releases: srv.URL}
	binPath, err := c.Fetch(context.Background(), "v0.8.0", "darwin", "arm64")
	if err != nil {
		t.Fatalf("Fetch 失败: %v", err)
	}
	defer os.RemoveAll(filepath.Dir(binPath))
	got, err := os.ReadFile(binPath)
	if err != nil {
		t.Fatalf("读取产出的二进制失败: %v", err)
	}
	if !bytes.Equal(got, binContent) {
		t.Fatalf("二进制内容不一致: got %q want %q", got, binContent)
	}
	fi, err := os.Stat(binPath)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode()&0o100 == 0 {
		t.Fatal("解出的二进制没有可执行位")
	}

	// 2) 篡改 checksums.txt → 返回错误,且不产出二进制
	srv2, _ := releaseServer(t, assets, []byte("deadbeef  "+asset+"\n"))
	c2 := &Checker{Releases: srv2.URL}
	binPath2, err := c2.Fetch(context.Background(), "v0.8.0", "darwin", "arm64")
	if err == nil {
		t.Fatal("checksum 不匹配时应当报错")
	}
	if binPath2 != "" {
		t.Fatalf("checksum 不匹配时不应产出二进制, got %q", binPath2)
	}
}

func TestFetchAssetName(t *testing.T) {
	binContent := []byte("fake")

	// windows+amd64 → 请求路径含 csi-windows-amd64.zip
	zipAsset := "csi-windows-amd64.zip"
	srvW, pathsW := releaseServer(t, map[string][]byte{zipAsset: buildZip(t, "csi.exe", binContent)}, nil)
	cW := &Checker{Releases: srvW.URL}
	binPath, err := cW.Fetch(context.Background(), "v0.8.0", "windows", "amd64")
	if err != nil {
		t.Fatalf("windows Fetch 失败: %v", err)
	}
	defer os.RemoveAll(filepath.Dir(binPath))
	got, _ := os.ReadFile(binPath)
	if !bytes.Equal(got, binContent) {
		t.Fatalf("zip 解出的 csi.exe 内容不一致: got %q", got)
	}
	joined := strings.Join(pathsW(), " ")
	if !strings.Contains(joined, zipAsset) {
		t.Fatalf("请求路径未包含 %s: %s", zipAsset, joined)
	}
	if !strings.Contains(joined, "/download/v0.8.0/") {
		t.Fatalf("请求路径未按 /download/<tag>/ 布局: %s", joined)
	}

	// darwin+arm64 → 请求路径含 csi-darwin-arm64.tar.gz
	tarAsset := "csi-darwin-arm64.tar.gz"
	srvD, pathsD := releaseServer(t, map[string][]byte{tarAsset: buildTarGz(t, "csi", binContent)}, nil)
	cD := &Checker{Releases: srvD.URL}
	binPath2, err := cD.Fetch(context.Background(), "v0.8.0", "darwin", "arm64")
	if err != nil {
		t.Fatalf("darwin Fetch 失败: %v", err)
	}
	defer os.RemoveAll(filepath.Dir(binPath2))
	if !strings.Contains(strings.Join(pathsD(), " "), tarAsset) {
		t.Fatalf("请求路径未包含 %s: %s", tarAsset, strings.Join(pathsD(), " "))
	}

	// 不支持的组合 → 错误(且不应发任何请求)
	srv3, paths3 := releaseServer(t, nil, nil)
	c3 := &Checker{Releases: srv3.URL}
	if _, err := c3.Fetch(context.Background(), "v0.8.0", "linux", "mips"); err == nil {
		t.Fatal("linux/mips 应当报错")
	}
	if len(paths3()) != 0 {
		t.Fatalf("不支持的平台不应发请求: %v", paths3())
	}
}

func TestReplaceUnix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix 路径")
	}
	dir := t.TempDir()
	self := filepath.Join(dir, "csi")
	if err := os.WriteFile(self, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	nb := filepath.Join(dir, "new")
	if err := os.WriteFile(nb, []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}
	bak, err := Replace(self, nb)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(self)
	if string(data) != "new" {
		t.Fatal("替换未生效")
	}
	if b, _ := os.ReadFile(bak); string(b) != "old" {
		t.Fatal("备份缺失")
	}
	// 可执行位保留
	fi, _ := os.Stat(self)
	if fi.Mode()&0o100 == 0 {
		t.Fatal("可执行位丢失")
	}
}

func TestIsHomebrewInstall(t *testing.T) {
	if !IsHomebrewInstall("/opt/homebrew/Cellar/csi/0.7.0/bin/csi") {
		t.Error("Cellar 未识别")
	}
	if !IsHomebrewInstall("/home/linuxbrew/.linuxbrew/Cellar/csi/0.7.0/bin/csi") {
		t.Error("linuxbrew 未识别")
	}
	if IsHomebrewInstall("/Users/x/.csi/bin/csi") {
		t.Error("误报")
	}
}
