package main

import (
	"strings"
	"testing"

	"csi/daemon/internal/autostart"
)

func TestAutostartParseDefaultIsStatus(t *testing.T) {
	t.Parallel()
	sub, err := autostart.ParseSub(nil)
	if err != nil || sub != "status" {
		t.Fatalf("default = %q %v", sub, err)
	}
}

func TestUsageListsAutostart(t *testing.T) {
	t.Parallel()
	usage := usageText()
	if !strings.Contains(usage, "autostart") {
		t.Fatalf("usage missing autostart:\n%s", usage)
	}
	if !strings.Contains(usage, "status | on | off") {
		t.Fatalf("usage missing autostart subcommands:\n%s", usage)
	}
}
