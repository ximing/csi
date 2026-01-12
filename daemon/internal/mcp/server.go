// Package mcp 实现 cdp-bridge 的 stdio MCP server：
// 将协议 §4 的 17 个浏览器工具暴露为 MCP tools，
// 作为薄代理转发到本机 daemon 的 POST /command（协议 §2.1）。
package mcp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"cdp-bridge/daemon/internal/daemon"
	"cdp-bridge/daemon/internal/version"
)

// Run 以 stdio 传输启动 MCP server，阻塞直到 stdin 关闭或 ctx 取消。
// MCP 客户端退出导致 stdin EOF 属于正常结束。
func Run(ctx context.Context) error {
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", daemon.Port())
	srv := NewServer(baseURL)
	if err := srv.Run(ctx, &mcpsdk.StdioTransport{}); err != nil {
		// SDK 对 stdin EOF 返回 "server is closing: EOF"（%v 拼接，无法 errors.Is 判定）。
		if errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) ||
			strings.Contains(err.Error(), "server is closing") {
			return nil
		}
		return err
	}
	return nil
}

// NewServer 构建注册好 17 个工具的 MCP server，工具调用转发到 baseURL（daemon HTTP 地址）。
func NewServer(baseURL string) *mcpsdk.Server {
	srv := mcpsdk.NewServer(&mcpsdk.Implementation{
		Name:    "cdp-bridge",
		Version: version.Version,
	}, nil)
	fwd := &forwarder{baseURL: baseURL}
	for _, def := range toolDefs {
		def := def
		srv.AddTool(&mcpsdk.Tool{
			Name:        def.name,
			Description: def.description,
			InputSchema: def.inputSchema(),
		}, fwd.handler(def))
	}
	return srv
}
