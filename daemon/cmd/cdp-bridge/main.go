// cdp-bridge daemon CLI。
//
// 先搭个最小骨架：serve 起一个只有 /healthz 的 HTTP server，version 打印版本。
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

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

// serve 最小占位：只监听回环，先跑通进程模型再加功能。
func serve() error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	log.Printf("cdp-bridge %s serving on 127.0.0.1:10088", version.Version)
	return http.ListenAndServe("127.0.0.1:10088", mux)
}

func usage() {
	fmt.Fprint(os.Stderr, `usage: cdp-bridge <command>

commands:
  serve    run daemon in foreground
  version  print version
`)
}
