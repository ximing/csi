// Package admin 提供 daemon 内置管理页（协议 §2.8）：
// go:embed 单文件 HTML，无外部请求、无框架、无构建步骤。
package admin

import (
	_ "embed"
	"net/http"
)

//go:embed admin.html
var html []byte

// Handler 返回管理页 handler。no-store 防止浏览器缓存旧版页面
// 与新 API 形状不匹配（daemon 二进制与页面同发版，正常不会漂移，
// 但升级后旧缓存页面调新接口的失败模式不值得留）。
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(html)
	})
}
