package tools

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

// maxPDFSize PDF 落盘大小上限（协议 §5：100MB）。
const maxPDFSize = 100 << 20

// PostProcess 大结果后处理（协议 §5）。非大结果工具原样返回。
func PostProcess(action string, args map[string]any, data any) (any, error) {
	switch action {
	case "screenshot":
		return saveScreenshot(args, data)
	case "save_as_pdf":
		return savePDF(args, data)
	default:
		return data, nil
	}
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
			fmt.Sprintf("cdp-bridge-screenshot-%d.%s", time.Now().UnixMilli(), ext))
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
