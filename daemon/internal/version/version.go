// Package version 定义 daemon 版本。
package version

// Version 当前 daemon 版本（协议 §6，hello_ack 中交换）。
// 开发期兜底值；release 构建由 CI 用 -X 注入 tag 版本，以此值与 tag 漂移不可能。
var Version = "0.7.0"
