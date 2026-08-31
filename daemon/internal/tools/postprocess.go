package tools

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"csi/daemon/internal/ws"
)

// maxPDFSize PDF 落盘大小上限（协议 §5：100MB）。
const maxPDFSize = 100 << 20

// PostProcess 大结果后处理（协议 §5）。非大结果工具原样返回。
func PostProcess(action string, args map[string]any, data any) (any, error) {
	// artifact 信封与工具名无关（协议 §3.5）：data 顶层带 artifact 对象即转落盘。
	if d, ok := data.(map[string]any); ok {
		if _, ok := d["artifact"]; ok {
			return saveArtifact(action, args, d)
		}
	}
	switch action {
	case "screenshot":
		return saveScreenshot(args, data)
	case "save_as_pdf":
		return savePDF(args, data)
	default:
		return data, nil
	}
}

// saveArtifact artifact 信封后处理（协议 §3.5/§5）：扩展返回
// {artifact:{encoding:"utf8", mimeType, suggestedName, data}, preview, sourceChars}，
// daemon 把 artifact.data 落盘，客户端只收到
// {truncated:true, preview, path, sizeBytes, mimeType}（snapshot 按 §4.3 附加 sourceChars）。
// 原始 artifact.data 永不进入 HTTP/MCP 响应。
func saveArtifact(action string, args map[string]any, d map[string]any) (any, error) {
	art, _ := d["artifact"].(map[string]any)
	if art == nil {
		return nil, fmt.Errorf("%s: malformed artifact envelope", action)
	}
	// 协议 §3.5 固定 encoding 为 "utf8"（utf8 字符串直接写字节）；其它取值协议未定义，不猜。
	if enc, _ := art["encoding"].(string); enc != "utf8" {
		return nil, fmt.Errorf("%s: unsupported artifact encoding %q (protocol §3.5 is utf8)", action, enc)
	}
	content, ok := art["data"].(string)
	if !ok {
		return nil, fmt.Errorf("%s: artifact.data missing or not a string", action)
	}
	mimeType, _ := art["mimeType"].(string)
	suggestedName, _ := art["suggestedName"].(string)
	preview, _ := d["preview"].(string)

	path, _ := args["path"].(string)
	if path == "" {
		// 默认 $TMPDIR/csi-<suggestedName>-<ts>（协议 §5）。
		name := sanitizeFilename(suggestedName)
		if name == "" {
			name = "artifact"
		}
		path = filepath.Join(os.TempDir(),
			fmt.Sprintf("csi-%s-%d", name, time.Now().UnixMilli()))
	}
	raw := []byte(content)
	if err := writeFileWithParents(path, raw); err != nil {
		// 落盘失败属于无法投递，按协议 §2.1 返回 result_too_large。
		return nil, &ws.ToolError{
			Message: "result too large to deliver: failed to persist artifact: " + err.Error(),
			Code:    "result_too_large",
		}
	}
	out := map[string]any{
		"truncated": true, // 协议 §5：内联被省略、完整内容在 path，不是数据缺失
		"preview":   preview,
		"path":      path,
		"sizeBytes": len(raw),
		"mimeType":  mimeType,
	}
	// snapshot full 转 artifact 时按协议 §4.3 附带 sourceChars（裁剪前规模）。
	if action == "snapshot" {
		if sc, ok := d["sourceChars"]; ok {
			out["sourceChars"] = sc
		}
	}
	return out, nil
}

// saveScreenshot 扩展返回 {format, dataLength, data(base64)}，
// daemon 解码落盘后返回 {format, path, sizeBytes, mimeType}。
func saveScreenshot(args map[string]any, data any) (any, error) {
	d, _ := data.(map[string]any)
	format, _ := d["format"].(string)
	if format == "" {
		format = "png"
	}
	raw, err := decodeBase64Field(d, "data")
	if err != nil {
		return nil, fmt.Errorf("screenshot: %w", err)
	}

	ext := format // png / jpeg
	path, _ := args["path"].(string)
	if path == "" {
		path = filepath.Join(os.TempDir(),
			fmt.Sprintf("csi-screenshot-%d.%s", time.Now().UnixMilli(), ext))
	}
	if err := writeFileWithParents(path, raw); err != nil {
		return nil, fmt.Errorf("screenshot: %w", err)
	}
	return map[string]any{
		"format":    format,
		"path":      path,
		"sizeBytes": len(raw),
		"mimeType":  mimeTypeFor(ext),
	}, nil
}

// savePDF 扩展返回 {data(base64), dataLength, pageTitle, requestedFileName}，
// daemon 解码落盘后返回 {path, sizeBytes, mimeType, pageTitle}。
func savePDF(args map[string]any, data any) (any, error) {
	d, _ := data.(map[string]any)
	// 扩展上报的 dataLength 是 base64 字符串长度（约为解码后的 4/3），不能用于预检；
	// 协议 §5 规定以解码后大小为准，故只在解码后检查。
	raw, err := decodeBase64Field(d, "data")
	if err != nil {
		return nil, fmt.Errorf("save_as_pdf: %w", err)
	}
	if len(raw) > maxPDFSize {
		return nil, fmt.Errorf("save_as_pdf: pdf exceeds 100MB limit (%d bytes)", len(raw))
	}

	pageTitle, _ := d["pageTitle"].(string)
	path, _ := args["path"].(string)
	if path == "" {
		// 默认文件名：args.file_name，其次页面标题（清洗非法字符）+ .pdf
		name, _ := args["file_name"].(string)
		if name == "" {
			name = pageTitle
		}
		name = sanitizeFilename(name)
		if name == "" {
			name = "page"
		}
		if !strings.HasSuffix(strings.ToLower(name), ".pdf") {
			name += ".pdf"
		}
		path = filepath.Join(os.TempDir(), name)
	}
	if err := writeFileWithParents(path, raw); err != nil {
		return nil, fmt.Errorf("save_as_pdf: %w", err)
	}
	return map[string]any{
		"path":      path,
		"sizeBytes": len(raw),
		"mimeType":  "application/pdf",
		"pageTitle": pageTitle,
	}, nil
}

// writeFileWithParents 父目录自动创建、覆盖写（协议 §5）。
// path 按字面写入，不校验、不改写；相对路径相对 daemon cwd。这是设计（协议 §7），不是沙箱。
func writeFileWithParents(path string, data []byte) error {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return os.WriteFile(path, data, 0o644)
}

func decodeBase64Field(d map[string]any, field string) ([]byte, error) {
	s, _ := d[field].(string)
	if s == "" {
		return nil, fmt.Errorf("missing %s (base64) in tool result", field)
	}
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("bad base64 %s: %w", field, err)
	}
	return raw, nil
}

// sanitizeFilename 清洗文件名非法字符：保留字母（含 CJK）、数字、. _ -，其余替换为 _。
func sanitizeFilename(name string) string {
	name = strings.TrimSpace(name)
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		case r == '.' || r == '_' || r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := strings.Trim(b.String(), ".") // 避免隐藏文件/空名
	const maxLen = 100
	if len(out) > maxLen {
		out = out[:maxLen]
	}
	return out
}

func mimeTypeFor(ext string) string {
	switch ext {
	case "jpeg", "jpg":
		return "image/jpeg"
	case "pdf":
		return "application/pdf"
	default:
		return "image/png"
	}
}
