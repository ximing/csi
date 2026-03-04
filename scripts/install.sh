#!/usr/bin/env bash
#
# csi installer (macOS / Linux)
#
# Downloads the prebuilt daemon, the built Chrome extension, and the Claude
# Code skill from GitHub Releases — no local build, no Go/Node required.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ximing/csi/master/scripts/install.sh | bash
#   curl -fsSL ... | bash -s -- --no-start        # don't start the daemon
#   curl -fsSL ... | bash -s -- --no-skill        # don't touch ~/.claude/skills
#   CSI_VERSION=v0.2.0 curl -fsSL ... | bash      # pin a release (default: latest)

set -euo pipefail

REPO="ximing/csi"
RELEASES="https://github.com/$REPO/releases"
INSTALL_DIR="$HOME/.csi"
BIN_DIR="$INSTALL_DIR/bin"
BIN_PATH="$BIN_DIR/csi"
EXT_DIR="$INSTALL_DIR/extension"
SKILL_DIR="$HOME/.claude/skills/csi"
E2E_SKILL_DIR="$HOME/.claude/skills/csi-e2e"

# ---------- output ----------

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; R=""; N=""
fi

step() { printf "\n%s==>%s %s\n" "$B" "$N" "$*"; }
info() { printf "    %s\n" "$*"; }
ok()   { printf "    %s✓%s %s\n" "$G" "$N" "$*"; }
warn() { printf "    %s!%s %s\n" "$Y" "$N" "$*" >&2; }
die()  { printf "    %s✗%s %s\n" "$R" "$N" "$*" >&2; exit 1; }

show_help() {
  cat <<EOF
csi installer (macOS / Linux)

Usage:
  curl -fsSL https://raw.githubusercontent.com/ximing/csi/master/scripts/install.sh | bash
  curl -fsSL ... | bash -s -- [options]

Options:
  -h, --help       Show this help.
  --no-start       Install everything, but don't start the daemon.
  --no-skill       Skip installing the Claude Code skill.
  -y, --yes        Don't prompt before overwriting an existing skill install.

Environment:
  CSI_VERSION      Pin to a specific release tag (e.g. v0.2.0; default: latest).

What it does:
  1. Download the prebuilt daemon  → $BIN_PATH
  2. Download the built extension  → $EXT_DIR  (load this in chrome://extensions)
  3. Install the Claude Code skills → $SKILL_DIR + $E2E_SKILL_DIR
  4. Start the daemon (idempotent)
EOF
}

# ---------- args ----------

NO_START=0
NO_SKILL=0
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)   show_help; exit 0 ;;
    --no-start)  NO_START=1; shift ;;
    --no-skill)  NO_SKILL=1; shift ;;
    -y|--yes)    ASSUME_YES=1; shift ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ---------- prerequisites ----------

for cmd in curl tar uname; do
  command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
done

# ---------- detect OS/arch ----------

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux" ;;
  *) die "unsupported OS: $(uname -s) (on Windows use scripts/install.ps1)" ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="amd64" ;;
  *) die "unsupported arch: $(uname -m)" ;;
esac

step "csi install"
info "platform : $OS-$ARCH"
info "install  : $INSTALL_DIR"

# Releases 里 latest 是个特殊目录，可以直接按名字下载；指定版本走 download/<tag>/
VERSION="${CSI_VERSION:-latest}"
if [ "$VERSION" = "latest" ]; then
  DL="$RELEASES/latest/download"
else
  DL="$RELEASES/download/$VERSION"
fi
info "version  : $VERSION"

download() { # url dest
  if ! curl -fsSL --retry 3 --connect-timeout 10 -o "$2" "$1"; then
    die "download failed: $1"
  fi
}

# ---------- 1. daemon ----------

step "[1/4] Installing daemon ($OS-$ARCH)"

mkdir -p "$BIN_DIR"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/csi-install.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

download "$DL/csi-$OS-$ARCH.tar.gz" "$TMP_DIR/daemon.tar.gz"
tar -xzf "$TMP_DIR/daemon.tar.gz" -C "$TMP_DIR"
mv "$TMP_DIR/csi" "$BIN_PATH"
chmod +x "$BIN_PATH"
ok "daemon: $BIN_PATH"

# ---------- 2. extension ----------

step "[2/4] Installing Chrome extension"

command -v unzip >/dev/null 2>&1 || die "'unzip' not found — install it and re-run"

download "$DL/csi-extension.zip" "$TMP_DIR/extension.zip"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
unzip -q "$TMP_DIR/extension.zip" -d "$EXT_DIR"
ok "extension: $EXT_DIR"

# ---------- 3. Claude Code skills ----------

install_skill() { # tar-name dest-dir
  download "$DL/$1" "$TMP_DIR/$1"
  rm -rf "$2"
  mkdir -p "$(dirname "$2")"
  tar -xzf "$TMP_DIR/$1" -C "$(dirname "$2")"
  ok "skill: $2"
}

if [ "$NO_SKILL" -eq 1 ]; then
  step "[3/4] Claude Code skills — skipped (--no-skill)"
else
  step "[3/4] Claude Code skills"

  do_install=1
  if { [ -d "$SKILL_DIR" ] || [ -d "$E2E_SKILL_DIR" ]; } && [ "$ASSUME_YES" -eq 0 ]; then
    # 通过管道运行（curl | bash）时 stdin 被脚本占用，从 /dev/tty 读回答
    if [ -t 0 ]; then
      read -r -p "    skills already present under ~/.claude/skills — overwrite? [y/N] " answer
    else
      read -r -p "    skills already present under ~/.claude/skills — overwrite? [y/N] " answer < /dev/tty || answer=""
    fi
    case "$answer" in y|Y|yes|YES) ;; *) do_install=0 ;; esac
  fi

  if [ "$do_install" -eq 1 ]; then
    install_skill csi-skill.tar.gz "$SKILL_DIR"
    install_skill csi-e2e-skill.tar.gz "$E2E_SKILL_DIR"
  else
    info "skipped (kept existing)"
  fi
fi

# ---------- 4. start daemon ----------

if [ "$NO_START" -eq 1 ]; then
  step "[4/4] Start daemon — skipped (--no-start)"
  info "start it later with:  $BIN_PATH start"
else
  step "[4/4] Starting daemon"
  if "$BIN_PATH" start; then
    ok "daemon is running"
  else
    warn "daemon failed to start — check logs at $INSTALL_DIR/logs/daemon.log"
  fi
fi

# ---------- done ----------

step "Done. Next steps:"
info "1. Load the extension in Chrome:"
info "     chrome://extensions → Developer mode → Load unpacked → select:"
info "       $EXT_DIR"
info "2. Open the extension popup and confirm it shows 'connected'"
info "3. Check status:  curl -s http://127.0.0.1:10088/status"
echo ""
