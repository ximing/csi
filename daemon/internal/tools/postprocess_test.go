package tools

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestScreenshotDefaultTempPath(t *testing.T) {
	t.Parallel()
	res, err := PostProcess("screenshot", map[string]any{}, map[string]any{
		"format": "jpeg",
		"data":   b64("jpeg-bytes"),
	})
	if err != nil {
		t.Fatal(err)
	}
	d := res.(map[string]any)
	path := d["path"].(string)
	if filepath.Dir(path) != filepath.Clean(os.TempDir()) {
		t.Fatalf("path = %q, want under TMPDIR", path)
	}
	if !strings.HasPrefix(filepath.Base(path), "csi-screenshot-") ||
		!strings.HasSuffix(path, ".jpeg") {
		t.Fatalf("path = %q", path)
	}
	if d["mimeType"] != "image/jpeg" {
		t.Fatalf("mimeType = %v", d["mimeType"])
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "jpeg-bytes" {
		t.Fatalf("content = %q", got)
	}
	os.Remove(path)
}

func TestPDFDefaultFileNameFromTitle(t *testing.T) {
	t.Parallel()
	res, err := PostProcess("save_as_pdf", map[string]any{}, map[string]any{
		"data":      b64("%PDF-fake"),
		"pageTitle": `My Report: 2026/Q1 <draft>`,
	})
	if err != nil {
		t.Fatal(err)
	}
	d := res.(map[string]any)
	path := d["path"].(string)
	base := filepath.Base(path)
	if !strings.HasSuffix(base, ".pdf") {
		t.Fatalf("path = %q, want .pdf", path)
	}
	for _, ch := range []string{"/", ":", "<", ">"} {
		if strings.Contains(base, ch) {
			t.Fatalf("filename %q contains illegal char %q", base, ch)
		}
	}
	if d["mimeType"] != "application/pdf" || d["pageTitle"] != `My Report: 2026/Q1 <draft>` {
		t.Fatalf("resp = %v", d)
	}
	os.Remove(path)
}

func TestPDFDataLengthNotUsedForPrecheck(t *testing.T) {
	t.Parallel()
	// dataLength 是 base64 字符串长度（约为解码后的 4/3），不得用于预检：
	// 上报超大 dataLength 但解码后很小，应正常通过。
	out := filepath.Join(t.TempDir(), "ok.pdf")
	res, err := PostProcess("save_as_pdf", map[string]any{"path": out}, map[string]any{
		"dataLength": float64(130 << 20),
		"data":       b64("%PDF-fake"),
	})
	if err != nil {
		t.Fatalf("err = %v, want pass (dataLength must not precheck)", err)
	}
	if res.(map[string]any)["sizeBytes"] != len("%PDF-fake") {
		t.Fatalf("res = %v", res)
	}
}

func TestPDFDecoded99MBPasses(t *testing.T) {
	t.Parallel()
	raw := make([]byte, 99<<20)
	out := filepath.Join(t.TempDir(), "big.pdf")
	res, err := PostProcess("save_as_pdf", map[string]any{"path": out}, map[string]any{
		"data": base64.StdEncoding.EncodeToString(raw),
	})
	if err != nil {
		t.Fatalf("err = %v, want 99MB decoded to pass", err)
	}
	if res.(map[string]any)["sizeBytes"] != 99<<20 {
		t.Fatalf("sizeBytes = %v", res.(map[string]any)["sizeBytes"])
	}
}

func TestPDFRejectOver100MB(t *testing.T) {
	t.Parallel()
	// 协议 §5：解码后 >100MB 拒绝
	raw := make([]byte, (100<<20)+1)
	out := filepath.Join(t.TempDir(), "too-big.pdf")
	_, err := PostProcess("save_as_pdf", map[string]any{"path": out}, map[string]any{
		"data": base64.StdEncoding.EncodeToString(raw),
	})
	if err == nil || !strings.Contains(err.Error(), "100MB") {
		t.Fatalf("err = %v, want 100MB limit error", err)
	}
	if _, statErr := os.Stat(out); !os.IsNotExist(statErr) {
		t.Fatalf("rejected pdf must not be written, stat err = %v", statErr)
	}
}

func TestPDFExplicitPath(t *testing.T) {
	t.Parallel()
	out := filepath.Join(t.TempDir(), "a", "b", "out.pdf")
	res, err := PostProcess("save_as_pdf", map[string]any{"path": out}, map[string]any{
		"data":      b64("%PDF-fake"),
		"pageTitle": "t",
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.(map[string]any)["path"] != out {
		t.Fatalf("path = %v", res)
	}
	if _, err := os.Stat(out); err != nil {
		t.Fatalf("file not written: %v", err)
	}
}

func TestScreenshotMissingData(t *testing.T) {
	t.Parallel()
	_, err := PostProcess("screenshot", map[string]any{}, map[string]any{"format": "png"})
	if err == nil {
		t.Fatal("want error for missing data")
	}
}

func TestSanitizeFilename(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"hello world":        "hello_world",
		"a/b\\c:d*e?f\"g<h>": "a_b_c_d_e_f_g_h_",
		"报告 2026":            "报告_2026",
		"...":                "",
		"":                   "",
	}
	for in, want := range cases {
		if got := sanitizeFilename(in); got != want {
			t.Errorf("sanitizeFilename(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPassthroughOtherTools(t *testing.T) {
	t.Parallel()
	in := map[string]any{"success": true, "tabId": float64(1)}
	res, err := PostProcess("navigate", map[string]any{}, in)
	if err != nil || res.(map[string]any)["tabId"] != float64(1) {
		t.Fatalf("res = %v, err = %v", res, err)
	}
}
