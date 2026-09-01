package tools

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"csi/daemon/internal/ws"
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

// artifactEnvelope 构造一份协议 §3.5 的内部 artifact 信封。
func artifactEnvelope(data string) map[string]any {
	return map[string]any{
		"artifact": map[string]any{
			"encoding":      "utf8",
			"mimeType":      "application/json",
			"suggestedName": "csi-evaluate-result.json",
			"data":          data,
		},
		"preview":     "...\n... preview truncated",
		"sourceChars": float64(len(data)),
	}
}

// artifactEnvelopeNamed 同 artifactEnvelope，但指定 suggestedName，
// 让默认落盘路径（$TMPDIR/csi-<suggestedName>-<ts>-<rand>，协议 §5）带可识别的名字。
func artifactEnvelopeNamed(name, data string) map[string]any {
	env := artifactEnvelope(data)
	env["artifact"].(map[string]any)["suggestedName"] = name
	return env
}

// pathSlot 并发落盘结果：各自写到的路径与期望内容。
type pathSlot struct{ path, content string }

// TestDefaultPathsUniqueAcrossSessions 协议 §5：默认路径尾随机后缀，
// 跨 session 并行（同 session FIFO 之外）同毫秒同名不互相覆盖。
// 没有 <rand> 时同名循环必撞同一路径、后写覆盖先写且内容互串。
func TestDefaultPathsUniqueAcrossSessions(t *testing.T) {
	t.Parallel()
	t.Run("artifact", func(t *testing.T) {
		slots := parallelDefaultPaths(t, func(i int) (string, string, error) {
			content := fmt.Sprintf("artifact-content-%d", i)
			res, err := PostProcess("evaluate", map[string]any{}, artifactEnvelopeNamed("race.json", content))
			if err != nil {
				return "", "", err
			}
			return res.(map[string]any)["path"].(string), content, nil
		})
		assertSlotsUniqueAndIntact(t, slots)
	})
	t.Run("screenshot", func(t *testing.T) {
		slots := parallelDefaultPaths(t, func(i int) (string, string, error) {
			content := fmt.Sprintf("shot-content-%d", i)
			res, err := PostProcess("screenshot", map[string]any{}, map[string]any{
				"format": "png",
				"data":   b64(content),
			})
			if err != nil {
				return "", "", err
			}
			return res.(map[string]any)["path"].(string), content, nil
		})
		assertSlotsUniqueAndIntact(t, slots)
	})
}

func parallelDefaultPaths(t *testing.T, run func(i int) (path, content string, err error)) []pathSlot {
	t.Helper()
	const n = 64
	slots := make(chan pathSlot, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			path, content, err := run(i)
			if err != nil {
				t.Errorf("PostProcess #%d: %v", i, err)
				return
			}
			slots <- pathSlot{path, content}
		}(i)
	}
	wg.Wait()
	close(slots)
	out := make([]pathSlot, 0, n)
	for s := range slots {
		out = append(out, s)
	}
	return out
}

func assertSlotsUniqueAndIntact(t *testing.T, slots []pathSlot) {
	t.Helper()
	seen := make(map[string]string, len(slots))
	for _, s := range slots {
		defer os.Remove(s.path) // 测试清理
		if prev, dup := seen[s.path]; dup {
			t.Fatalf("default path collision: %q (contents %q vs %q)", s.path, prev, s.content)
		}
		seen[s.path] = s.content
	}
	for path, want := range seen {
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %q: %v", path, err)
		}
		if string(got) != want {
			t.Fatalf("file %q = %q, want %q (later write overwrote earlier session's data)", path, got, want)
		}
	}
}

func TestArtifactPersistAndClientEnvelope(t *testing.T) {
	t.Parallel()
	content := `{"type":"object","value":{"big":true}}`
	res, err := PostProcess("evaluate", map[string]any{}, artifactEnvelopeNamed("persist-envelope.json", content))
	if err != nil {
		t.Fatal(err)
	}
	d := res.(map[string]any)

	// 写盘文件内容完整
	path := d["path"].(string)
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != content {
		t.Fatalf("file content = %q, want %q", got, content)
	}
	defer os.Remove(path)

	// 默认路径：$TMPDIR/csi-<suggestedName>-<ts>（协议 §5）
	if filepath.Dir(path) != filepath.Clean(os.TempDir()) {
		t.Fatalf("path = %q, want under TMPDIR", path)
	}
	if !strings.HasPrefix(filepath.Base(path), "csi-persist-envelope.json-") {
		t.Fatalf("path = %q, want csi-<suggestedName>-<ts>", path)
	}

	// 客户端信封恰好五个字段（协议 §5），且不出现原始 data/artifact
	want := map[string]any{
		"truncated": true,
		"preview":   "...\n... preview truncated",
		"path":      path,
		"sizeBytes": len(content),
		"mimeType":  "application/json",
	}
	if len(d) != len(want) {
		t.Fatalf("client envelope keys = %v, want %v", d, want)
	}
	for k, v := range want {
		if d[k] != v {
			t.Errorf("field %q = %v, want %v", k, d[k], v)
		}
	}
	if _, leaked := d["artifact"]; leaked {
		t.Error("raw artifact leaked to client response")
	}
	if _, leaked := d["data"]; leaked {
		t.Error("raw data leaked to client response")
	}
}

func TestArtifactExplicitPath(t *testing.T) {
	t.Parallel()
	out := filepath.Join(t.TempDir(), "a", "b", "result.json")
	res, err := PostProcess("network", map[string]any{"path": out}, artifactEnvelope("body-bytes"))
	if err != nil {
		t.Fatal(err)
	}
	d := res.(map[string]any)
	if d["path"] != out {
		t.Fatalf("path = %v, want %s", d["path"], out)
	}
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "body-bytes" {
		t.Fatalf("content = %q", got)
	}
}

func TestArtifactSnapshotKeepsSourceChars(t *testing.T) {
	t.Parallel()
	// 协议 §4.3：snapshot full 转 artifact 时客户端响应附带 sourceChars
	res, err := PostProcess("snapshot", map[string]any{}, artifactEnvelopeNamed("snap-keep-sourcechars.json", "tree"))
	if err != nil {
		t.Fatal(err)
	}
	d := res.(map[string]any)
	if d["sourceChars"] != float64(4) {
		t.Fatalf("sourceChars = %v, want 4", d["sourceChars"])
	}
	defer os.Remove(d["path"].(string))

	// 其它工具不带 sourceChars
	res2, err := PostProcess("cdp", map[string]any{}, artifactEnvelopeNamed("cdp-no-sourcechars.json", "tree"))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := res2.(map[string]any)["sourceChars"]; ok {
		t.Error("cdp artifact envelope should not carry sourceChars")
	}
	defer os.Remove(res2.(map[string]any)["path"].(string))
}

func TestArtifactWriteFailureIsResultTooLarge(t *testing.T) {
	t.Parallel()
	// 父目录撞上一个已存在的文件：MkdirAll 必失败
	base := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(base, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := PostProcess("evaluate", map[string]any{"path": filepath.Join(base, "out.json")}, artifactEnvelope("x"))
	if err == nil || !strings.HasPrefix(err.Error(), "result too large to deliver") {
		t.Fatalf("err = %v, want result_too_large wording", err)
	}
	// 协议 §2.1：落盘失败带 code=result_too_large
	var te *ws.ToolError
	if !errors.As(err, &te) || te.Code != "result_too_large" {
		t.Fatalf("err = %v, want ToolError{Code: result_too_large}", err)
	}
}

func TestArtifactRejectsNonUtf8Encoding(t *testing.T) {
	t.Parallel()
	env := artifactEnvelope("x")
	env["artifact"].(map[string]any)["encoding"] = "base64"
	_, err := PostProcess("evaluate", map[string]any{}, env)
	if err == nil || !strings.Contains(err.Error(), "encoding") {
		t.Fatalf("err = %v, want unsupported encoding error", err)
	}
}

func TestArtifactMissingData(t *testing.T) {
	t.Parallel()
	env := artifactEnvelope("x")
	delete(env["artifact"].(map[string]any), "data")
	_, err := PostProcess("evaluate", map[string]any{}, env)
	if err == nil || !strings.Contains(err.Error(), "artifact.data") {
		t.Fatalf("err = %v, want missing data error", err)
	}
}

// TestArtifactNetworkDetailKeepsMeta 协议 §4：network detail（body_mode:file）
// 信封同层的 requestId/url/method/status/base64Encoded 必须随客户端响应保留——
// 客户端拿到落盘文件要知道它属于哪个请求。
func TestArtifactNetworkDetailKeepsMeta(t *testing.T) {
	t.Parallel()
	env := artifactEnvelopeNamed("network-detail-body.bin", "response-body")
	env["requestId"] = "req-42"
	env["url"] = "https://example.com/api"
	env["method"] = "POST"
	env["status"] = float64(200)
	env["base64Encoded"] = false

	res, err := PostProcess("network", map[string]any{}, env)
	if err != nil {
		t.Fatal(err)
	}
	d := res.(map[string]any)
	defer os.Remove(d["path"].(string))

	for k, want := range map[string]any{
		"requestId":     "req-42",
		"url":           "https://example.com/api",
		"method":        "POST",
		"status":        float64(200),
		"base64Encoded": false,
	} {
		if d[k] != want {
			t.Errorf("field %q = %v, want %v (sibling meta must survive persist)", k, d[k], want)
		}
	}
	// network detail 的返回形状带 sourceChars（协议 §4 detail 行）
	if d["sourceChars"] != float64(len("response-body")) {
		t.Errorf("sourceChars = %v", d["sourceChars"])
	}
	if _, leaked := d["artifact"]; leaked {
		t.Error("raw artifact leaked to client response")
	}
}

// TestArtifactSnapshotFullKeepsPageMeta 协议 §4.3：snapshot full 转 artifact 时，
// 信封同层的 url/title/mode/matches 必须保留——客户端要知道 artifact 属于哪个页面。
func TestArtifactSnapshotFullKeepsPageMeta(t *testing.T) {
	t.Parallel()
	env := artifactEnvelopeNamed("snapshot-full-tree.json", "[]")
	env["url"] = "https://example.com/"
	env["title"] = "Example"
	env["mode"] = "full"
	env["chars"] = float64(10)
	env["source_chars"] = float64(2)
	env["returned_chars"] = float64(10)
	env["matches"] = float64(3)

	res, err := PostProcess("snapshot", map[string]any{}, env)
	if err != nil {
		t.Fatal(err)
	}
	d := res.(map[string]any)
	defer os.Remove(d["path"].(string))

	for k, want := range map[string]any{
		"url":     "https://example.com/",
		"title":   "Example",
		"mode":    "full",
		"matches": float64(3),
	} {
		if d[k] != want {
			t.Errorf("field %q = %v, want %v", k, d[k], want)
		}
	}
	if d["sourceChars"] != float64(2) {
		t.Errorf("sourceChars = %v, want 2", d["sourceChars"])
	}
}

// TestCdpResultWithUnrelatedArtifactFieldNotHijacked 协议 §4.2：cdp 结果原样透传，
// 其中合法出现的同名 artifact 字段不符合 §3.5 信封形状时不得被劫持进落盘。
func TestCdpResultWithUnrelatedArtifactFieldNotHijacked(t *testing.T) {
	t.Parallel()
	cases := map[string]map[string]any{
		"artifact 是字符串": {"artifact": "not-an-envelope"},
		"artifact 是数字":  {"artifact": float64(1)},
		"artifact 对象但无 encoding": {"artifact": map[string]any{
			"data":     "x",
			"mimeType": "text/plain",
		}},
		"artifact 是 nil": {"artifact": nil},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			res, err := PostProcess("cdp", map[string]any{}, in)
			if err != nil {
				t.Fatalf("err = %v, want passthrough without hijack", err)
			}
			d, ok := res.(map[string]any)
			if !ok {
				t.Fatalf("res = %v, want original map", res)
			}
			if len(d) != len(in) {
				t.Fatalf("res keys = %v, want passthrough of %v", d, in)
			}
		})
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
