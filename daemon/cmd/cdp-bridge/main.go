// cdp-bridge daemon CLI。
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"

	"cdp-bridge/daemon/internal/server"
	"cdp-bridge/daemon/internal/version"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		if err := serve(); err != nil {
			log.Fatal(err)
		}
	case "version":
		fmt.Println("cdp-bridge " + version.Version)
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

// serve 前台运行 daemon，只监听回环。
func serve() error {
	port := 10088
	if v := os.Getenv("CDP_BRIDGE_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil {
			port = p
		}
	}
	srv := server.New(port, nil)
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	log.Printf("cdp-bridge %s serving on %s", version.Version, addr)
	return http.ListenAndServe(addr, srv.Handler())
}

func usage() {
	fmt.Fprint(os.Stderr, `usage: cdp-bridge <command>

commands:
  serve    run daemon in foreground
  version  print version

environment:
  CDP_BRIDGE_PORT  listen port (default 10088)
`)
}
