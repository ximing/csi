package main

import (
	"fmt"
	"os"

	"csi/daemon/internal/autostart"
)

// cmdAutostart 登录自启：status / on / off（无子命令等同 status）。
func cmdAutostart() error {
	sub, err := autostart.ParseSub(os.Args[2:])
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	switch sub {
	case "status":
		on, err := autostart.Enabled(home)
		if err != nil {
			return err
		}
		fmt.Print(autostart.FormatStatus(on, autostart.UnitPath(home)))
		return nil
	case "on":
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		if err := autostart.Enable(home, exe); err != nil {
			return err
		}
		fmt.Print(autostart.FormatStatus(true, autostart.UnitPath(home)))
		return nil
	case "off":
		if err := autostart.Disable(home); err != nil {
			return err
		}
		fmt.Print(autostart.FormatStatus(false, autostart.UnitPath(home)))
		return nil
	default:
		return fmt.Errorf("unknown autostart command: %s", sub)
	}
}
