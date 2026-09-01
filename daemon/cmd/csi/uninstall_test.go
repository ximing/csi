package main

import (
	"bytes"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// 装配一组全注入的 uninstallDeps,calls 记录调用顺序。
func fakeUninstallDeps(dir string, calls *[]string, out, errOut *bytes.Buffer) uninstallDeps {
	return uninstallDeps{
		Dir:  dir,
		Home: filepath.Join(dir, "home"),
		Confirm: func(string) bool {
			*calls = append(*calls, "confirm")
			return true
		},
		Stop: func() error {
			*calls = append(*calls, "stop")
			return nil
		},
		DisableAutostart: func() error {
			*calls = append(*calls, "disable")
			return nil
		},
		RemoveAll: func(p string) error {
			*calls = append(*calls, "removeall:"+p)
			return nil
		},
		SpawnSelfDelete: func(d string) error {
			*calls = append(*calls, "spawn:"+d)
			return nil
		},
		Out:    out,
		ErrOut: errOut,
	}
}

func TestUninstallFlow(t *testing.T) {
	var calls []string
	var out, errOut bytes.Buffer
	dir := filepath.Join(t.TempDir(), ".csi")
	deps := fakeUninstallDeps(dir, &calls, &out, &errOut)

	if err := runUninstall(nil, deps); err != nil {
		t.Fatalf("runUninstall: %v", err)
	}
	want := []string{"confirm", "stop", "disable", "removeall:" + dir}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("调用顺序 = %v, 期望 %v", calls, want)
	}
	// 输出要引导手动清理技能目录与 Chrome 扩展
	if !strings.Contains(out.String(), "skills") {
		t.Errorf("输出缺少技能目录清理引导: %q", out.String())
	}
	if !strings.Contains(out.String(), "chrome://extensions") {
		t.Errorf("输出缺少扩展清理引导: %q", out.String())
	}
}

func TestUninstallDeclined(t *testing.T) {
	var calls []string
	var out, errOut bytes.Buffer
	dir := filepath.Join(t.TempDir(), ".csi")
	deps := fakeUninstallDeps(dir, &calls, &out, &errOut)
	deps.Confirm = func(string) bool { return false }

	if err := runUninstall(nil, deps); err != nil {
		t.Fatalf("runUninstall: %v", err)
	}
	if len(calls) != 0 {
		t.Fatalf("取消后不应有任何副作用,实际调用: %v", calls)
	}
	if !strings.Contains(out.String(), "aborted") {
		t.Errorf("输出缺少 aborted: %q", out.String())
	}
}

func TestUninstallYesFlag(t *testing.T) {
	var calls []string
	var out, errOut bytes.Buffer
	dir := filepath.Join(t.TempDir(), ".csi")
	deps := fakeUninstallDeps(dir, &calls, &out, &errOut)
	deps.Confirm = func(string) bool {
		t.Error("-y 下不应调用 Confirm")
		return false
	}

	if err := runUninstall([]string{"-y"}, deps); err != nil {
		t.Fatalf("runUninstall: %v", err)
	}
	want := []string{"stop", "disable", "removeall:" + dir}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("调用顺序 = %v, 期望 %v", calls, want)
	}
}
