// csi daemon CLI。
//
// 子命令：
//
//	serve      前台运行 daemon
//	start      后台守护（幂等：已在运行则 no-op）
//	stop       停止后台 daemon（--force 跳过身份校验）
//	restart    重启后台 daemon
//	status     查询运行状态
//	autostart  登录自启（status | on | off；默认 status）
//	version    打印版本
//	mcp        stdio MCP server（20 个浏览器工具，转发到本机 daemon）
package main

import (
	"fmt"
	"os"

	"csi/daemon/internal/version"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = cmdServe()
	case "start":
		err = cmdStart()
	case "stop":
		err = cmdStop()
	case "restart":
		err = cmdRestart()
	case "status":
		err = cmdStatus()
	case "autostart":
		err = cmdAutostart()
	case "version":
		fmt.Println("csi " + version.Version)
	case "mcp":
		err = cmdMCP()
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "csi %s: %v\n", os.Args[1], err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, usageText())
}

func usageText() string {
	return `usage: csi <command>

commands:
  serve           run daemon in foreground
  start           start daemon in background (no-op if already running)
  stop [--force]  stop background daemon
  restart         restart background daemon
  status          show daemon status
  autostart       login autostart (status | on | off; default status)
  version         print version
  mcp             run MCP server over stdio (forwards to the local daemon)

environment:
  CSI_PORT  listen port (default 10088)
`
}
