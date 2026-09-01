package tools

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
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
	// artifact 信封与工具名无关（协议 §3.5）：data 顶层带 artifact 信封即转落盘。
	// 但不能只看 key 存在：cdp 是裸透传（协议 §4.2），其结果里合法出现的
	// 同名 artifact 字段不得被劫持，必须严格匹配信封形状。
	if d, ok := data.(map[string]any); ok {
		if isArtifactEnvelope(d) {
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

// isArtifactEnvelope 判定协议 §3.5 的 artifact 信封：artifact 是对象且带
// encoding 字符串字段（协议固定 "utf8"，非 utf8 留给 saveArtifact 报错）。
// cdp 透传结果里同名的 artifact 字段（非对象，或对象但无 encoding）不算信封。
func isArtifactEnvelope(d map[string]any) bool {
	art, ok := d["artifact"].(map[string]any)
	if !ok {
		return false
	}
	_, ok = art["encoding"].(string)
	return ok
}

// saveArtifact artifact 信封后处理（协议 §3.5/§5）：扩展返回
// {artifact:{encoding:"utf8", mimeType, suggestedName, data}, preview, sourceChars, ...同层业务字段}，
// daemon 把 artifact.data 落盘，客户端收到
// {truncated:true, preview, path, sizeBytes, mimeType, ...同层业务字段}。
// 同层业务字段（network detail 的 requestId/url/method/status、snapshot full 的
// url/title/mode/matches 等，协议 §4）原样保留；原始 artifact.data 永不进入
// HTTP/MCP 响应。sourceChars 只随协议明确要求的工具回传（snapshot §4.3、
// network detail §4）；evaluate/cdp 的客户端信封固定五字段（§5）。
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
		// 默认 $TMPDIR/csi-<suggestedName>-<ts>-<rand>（协议 §5）。
		name := sanitizeFilename(suggestedName)
		if name == "" {
			name = "artifact"
		}
		path = filepath.Join(os.TempDir(),
			fmt.Sprintf("csi-%s-%d-%s", name, time.Now().UnixMilli(), randSuffix()))
	}
	raw := []byte(content)
	if err := writeFileWithParents(path, raw); err != nil {
		// 落盘失败属于无法投递，按协议 §2.1 返回 result_too_large。
		return nil, &ws.ToolError{
			Message: "result too large to deliver: failed to persist artifact: " + err.Error(),
			Code:    "result_too_large",
		}
	}
	// 同层业务字段先合入（artifact 除外——原始 data 绝不回传），
	// 再覆盖落盘元信息（协议 §5）：mimeType 以完整内容的为准，
	// 例如 network detail 信封同层的 mimeType 是响应头的、可能与落盘内容不同。
	out := make(map[string]any, len(d)+4)
	for k, v := range d {
		switch k {
		case "artifact":
			continue
		case "sourceChars":
			if action != "snapshot" && action != "network" {
				continue
			}
		}
		out[k] = v
	}
	out["truncated"] = true // 协议 §5：内联被省略、完整内容在 path，不是数据缺失
	out["preview"] = preview
	out["path"] = path
	out["sizeBytes"] = len(raw)
	out["mimeType"] = mimeType
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
			fmt.Sprintf("csi-screenshot-%d-%s.%s", time.Now().UnixMilli(), randSuffix(), ext))
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

// randSuffix 默认落盘路径的随机后缀（协议 §5 的 <rand>）：协议 §3.4 的
// per-session FIFO 只串行单 session 内，跨 session 并行可能同毫秒触发
// 同名默认路径（suggestedName 是常量），没有随机后缀后写会覆盖先写，
// 两个客户端互相读到对方 session 的内容。
func randSuffix() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 不可用只在极端环境发生；退化为纳秒时间戳仍避免同毫秒互踩。
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
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
