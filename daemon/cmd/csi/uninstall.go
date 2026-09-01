// csi uninstall 子命令:停 daemon、撤登录自启与每日更新定时任务、清 ~/.csi。
package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"csi/daemon/internal/autostart"
	"csi/daemon/internal/daemon"
)

// uninstallDeps runUninstall 的全部外部依赖,测试逐字段注入(同 updateDeps 模式)。
type uninstallDeps struct {
	Dir              string                   // 运行目录(~/.csi)
	Home             string                   // 用户 home,autostart 与技能路径的基准
	Confirm          func(prompt string) bool // 交互确认;-y 时不调
	Stop             func() error             // 默认 stopDaemon(dir,false),没在跑不报错
	DisableAutostart func() error             // 默认 autostart.Disable(home),含定时任务移除
	RemoveAll        func(path string) error  // unix 删目录,默认 os.RemoveAll
	SpawnSelfDelete  func(dir string) error   // windows 专用:脱离进程延迟自删(运行中的 exe 删不掉)
	Out              io.Writer                // 正常输出
	ErrOut           io.Writer                // 确认提示等诊断输出
}

// runUninstall 执行 csi uninstall 主流程。错误一律返回,由 main 写 stderr 并非零退出。
func runUninstall(args []string, deps uninstallDeps) error {
	var yes bool
	for _, a := range args {
		switch a {
		case "-y", "--yes":
			yes = true
		default:
			return fmt.Errorf("unknown flag: %s", a)
		}
	}
	out := deps.Out
	if out == nil {
		out = io.Discard
	}
	errOut := deps.ErrOut
	if errOut == nil {
		errOut = io.Discard
	}

	if !yes {
		fmt.Fprintf(errOut, "将停止 csi daemon、撤销登录自启与每日更新任务,并删除目录 %s\n", deps.Dir)
		if deps.Confirm == nil || !deps.Confirm("确认卸载? [y/N] ") {
			fmt.Fprintln(out, "uninstall aborted")
			return nil
		}
	}

	if err := deps.Stop(); err != nil {
		return fmt.Errorf("停止 daemon 失败: %w", err)
	}
	if err := deps.DisableAutostart(); err != nil {
		return fmt.Errorf("撤销登录自启失败: %w", err)
	}

	if runtime.GOOS == "windows" {
		// 运行中的 csi.exe 位于 ~/.csi/bin 下,Windows 不允许删除自身:
		// spawn 一个脱离的 cmd,延迟数秒后删目录,本进程立即返回。
		if err := deps.SpawnSelfDelete(deps.Dir); err != nil {
			return fmt.Errorf("调度目录删除失败: %w", err)
		}
		fmt.Fprintf(out, "%s 将在数秒后由后台进程删除\n", deps.Dir)
	} else {
		if err := deps.RemoveAll(deps.Dir); err != nil {
			return fmt.Errorf("删除 %s 失败: %w", deps.Dir, err)
		}
		fmt.Fprintf(out, "已删除 %s\n", deps.Dir)
	}

	printManualCleanupGuide(out, deps.Home)
	return nil
}

// printManualCleanupGuide 输出卸载后需手动清理的部分:技能目录与 Chrome 扩展。
func printManualCleanupGuide(out io.Writer, home string) {
	skillsBase := filepath.Join(home, ".claude", "skills")
	fmt.Fprintln(out, "以下部分需手动清理:")
	fmt.Fprintf(out, "  技能目录(及其它 agent 的同名技能): %s、%s\n",
		filepath.Join(skillsBase, "csi"), filepath.Join(skillsBase, "csi-e2e"))
	fmt.Fprintln(out, "  Chrome 扩展: 打开 chrome://extensions 移除 csi 扩展")
}

// cmdUninstall 是 csi uninstall 的薄壳:装配真实依赖后转 runUninstall。
func cmdUninstall() error {
	dir, err := daemon.RunDir()
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	return runUninstall(os.Args[2:], uninstallDeps{
		Dir:     dir,
		Home:    home,
		Confirm: confirmUninstall,
		Stop: func() error {
			return stopDaemon(dir, false)
		},
		DisableAutostart: func() error {
			return autostart.Disable(home)
		},
		RemoveAll:       os.RemoveAll,
		SpawnSelfDelete: spawnSelfDelete,
		Out:             os.Stdout,
		ErrOut:          os.Stderr,
	})
}

// confirmUninstall 打印 prompt 并读一行确认。unix 从 /dev/tty 读(stdin 可能
// 被管道占用),打不开 /dev/tty 时回退 stdin;windows 直接 stdin。
// 只有 y/yes 视为确认。
func confirmUninstall(prompt string) bool {
	fmt.Fprint(os.Stderr, prompt)
	in := os.Stdin
	if runtime.GOOS != "windows" {
		if tty, err := os.OpenFile("/dev/tty", os.O_RDONLY, 0); err == nil {
			defer tty.Close()
			in = tty
		}
	}
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && line == "" {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true
	}
	return false
}

// spawnSelfDelete windows 自删:启动脱离的 cmd 进程,ping 兜底延迟约 2 秒后
// rmdir 整个目录,Start 后立即返回不等退出。
func spawnSelfDelete(dir string) error {
	cmd := exec.Command("cmd", "/c", `ping 127.0.0.1 -n 3 > nul & rmdir /s /q "`+dir+`"`)
	if err := cmd.Start(); err != nil {
		return err
	}
	// 释放子进程资源,不 Wait(等待则失去"脱离"意义)
	return cmd.Process.Release()
}
