#!/usr/bin/env bash
#
# csi installer (macOS / Linux)
#
# Downloads the prebuilt daemon (and optionally the unpacked Chrome
# extension) plus coding-agent skills from GitHub Releases — no local
# build, no Go/Node required. Chrome Web Store users pass --no-extension.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ximing/csi/master/scripts/install.sh | bash
#   curl -fsSL ... | bash -s -- --no-extension    # store users: skip unpacked zip
#   curl -fsSL ... | bash -s -- --no-start        # don't start the daemon
#   curl -fsSL ... | bash -s -- --no-autostart    # don't register login autostart
#   curl -fsSL ... | bash -s -- --no-skill        # don't install any skills
#   curl -fsSL ... | bash -s -- --agents codex,cursor  # pick skill targets (default: claude)
#   CSI_VERSION=v0.2.0 curl -fsSL ... | bash      # pin a release (default: latest)

set -euo pipefail

REPO="ximing/csi"
RELEASES="https://github.com/$REPO/releases"
INSTALL_DIR="$HOME/.csi"
BIN_DIR="$INSTALL_DIR/bin"
BIN_PATH="$BIN_DIR/csi"
EXT_DIR="$INSTALL_DIR/extension"
AGENTS="${CSI_AGENTS:-claude}"

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

# 耗时格式化：<60s 走 3.2s（浮点）或 3s（整数），>=60s 走 1m12s
# awk 跨 GNU/BSD 都行，不依赖 bash 4+ 的 EPOCHREALTIME 或 GNU date 的 %N
fmt_elapsed() { # seconds (float or int string)
  awk -v t="$1" 'BEGIN{
    if (t+0 >= 60)      printf "%dm%ds", int(t/60), int(t)%60
    else if (t == int(t)) printf "%ds", int(t)
    else                printf "%.1fs", t+0
  }'
}

show_help() {
  cat <<EOF
csi installer (macOS / Linux)

Usage:
  curl -fsSL https://raw.githubusercontent.com/ximing/csi/master/scripts/install.sh | bash
  curl -fsSL ... | bash -s -- [options]

Options:
  -h, --help         Show this help.
  --no-extension     Skip the unpacked extension zip (Chrome Web Store users).
  --no-start         Install everything, but don't start the daemon.
  --no-autostart     Don't register login autostart (csi start at login).
                     Re-running the installer re-enables autostart even if
                     you previously ran csi autostart off.
  --no-skill         Skip installing the coding-agent skills entirely.
  --agents LIST      Comma-separated skill targets: claude, codex, cursor,
                     agents (the ~/.agents standard dir), opencode, or all.
                     Default: claude. (Alias for CSI_AGENTS.)
  -y, --yes          Don't prompt before overwriting an existing skill install.

Environment:
  CSI_VERSION        Pin to a specific release tag (e.g. v0.2.0; default: latest).
  CSI_AGENTS         Same as --agents (e.g. "codex,cursor").
  CSI_NO_EXTENSION   Set to 1 to skip the unpacked extension zip.
  CSI_NO_AUTOSTART   Set to 1 to skip login autostart.

Skill target directories:
  claude    ~/.claude/skills           (Claude Code)
  codex     ~/.codex/skills            (Codex App / CLI)
  cursor    ~/.cursor/skills           (Cursor)
  agents    ~/.agents/skills           (cross-tool standard; Cursor & OpenCode read it)
  opencode  ~/.config/opencode/skills  (OpenCode)

What it does:
  1. Download the prebuilt daemon  → $BIN_PATH
  2. Download the built extension  → $EXT_DIR  (sideload; skip with --no-extension)
  3. Install the skills            → each target's skills dir (see above)
  4. Register login autostart (skip with --no-autostart / CSI_NO_AUTOSTART=1)
  5. Start the daemon (idempotent)
EOF
}

# ---------- args ----------

NO_START=0
NO_AUTOSTART=0
NO_SKILL=0
NO_EXT=0
ASSUME_YES=0
[ "${CSI_NO_EXTENSION:-}" = "1" ] && NO_EXT=1
[ "${CSI_NO_AUTOSTART:-}" = "1" ] && NO_AUTOSTART=1
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)         show_help; exit 0 ;;
    --no-extension)    NO_EXT=1; shift ;;
    --no-start)        NO_START=1; shift ;;
    --no-autostart)    NO_AUTOSTART=1; shift ;;
    --no-skill)        NO_SKILL=1; shift ;;
    --agents)          [ $# -ge 2 ] || die "--agents requires a value"; AGENTS="$2"; shift 2 ;;
    -y|--yes)          ASSUME_YES=1; shift ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ---------- prerequisites ----------

for cmd in curl tar uname; do
  command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
done
# unzip 只在装解压版扩展时需要；--no-extension 时跳过（PS 端用内置 Expand-Archive 无此检查）
if [ "$NO_EXT" -eq 0 ]; then
  command -v unzip >/dev/null 2>&1 || die "required command not found: unzip (or pass --no-extension to skip the unpacked extension)"
fi

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

DL_LAST_TIME=""
download() { # url dest
  # stderr 是 TTY 时显示 curl 进度条 (--progress-bar 走 stderr)；
  # 否则用 -sS 静默 (CI / curl|bash 重定向)。下载耗时由 -w time_total 返回到 DL_LAST_TIME。
  local progress=()
  if [ -t 2 ]; then
    progress=(--progress-bar)
  else
    progress=(-sS)
  fi
  if ! DL_LAST_TIME=$(curl -fL --retry 3 --connect-timeout 10 \
        "${progress[@]}" -w '%{time_total}' -o "$2" "$1"); then
    die "download failed: $1"
  fi
}

# ---------- 1. daemon ----------

step "[1/5] Installing daemon ($OS-$ARCH)"

mkdir -p "$BIN_DIR"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/csi-install.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

download "$DL/csi-$OS-$ARCH.tar.gz" "$TMP_DIR/daemon.tar.gz"
tar -xzf "$TMP_DIR/daemon.tar.gz" -C "$TMP_DIR"
mv "$TMP_DIR/csi" "$BIN_PATH"
chmod +x "$BIN_PATH"
ok "daemon: $BIN_PATH ($(fmt_elapsed "$DL_LAST_TIME"))"

# ---------- 2. extension ----------

if [ "$NO_EXT" -eq 1 ]; then
  step "[2/5] Chrome extension — skipped (--no-extension)"
  info "install from the Chrome Web Store:"
  info "  https://chromewebstore.google.com/detail/csi/mlnlngdpkodcnblmdgdnlaidijaffeol"
else
  step "[2/5] Installing Chrome extension"

  download "$DL/csi-extension.zip" "$TMP_DIR/extension.zip"
  rm -rf "$EXT_DIR"
  mkdir -p "$EXT_DIR"
  unzip -q "$TMP_DIR/extension.zip" -d "$EXT_DIR"
  ok "extension: $EXT_DIR ($(fmt_elapsed "$DL_LAST_TIME"))"
fi

# ---------- 3. coding-agent skills ----------

agent_skills_base() { # agent → skills base dir
  case "$1" in
    claude)   echo "$HOME/.claude/skills" ;;
    codex)    echo "$HOME/.codex/skills" ;;
    cursor)   echo "$HOME/.cursor/skills" ;;
    agents)   echo "$HOME/.agents/skills" ;;
    opencode) echo "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills" ;;
    *)        return 1 ;;
  esac
}

install_skill() { # tar-name dest-dir（tarball 只下载一次，多目标复用）
  if [ ! -f "$TMP_DIR/$1" ]; then
    download "$DL/$1" "$TMP_DIR/$1"
    ok "  fetched $1 ($(fmt_elapsed "$DL_LAST_TIME"))"
  fi
  rm -rf "$2"
  mkdir -p "$(dirname "$2")"
  tar -xzf "$TMP_DIR/$1" -C "$(dirname "$2")"
  ok "skill: $2"
}

if [ "$NO_SKILL" -eq 1 ]; then
  step "[3/5] Coding-agent skills — skipped (--no-skill)"
else
  step "[3/5] Coding-agent skills"

  [ "$AGENTS" = "all" ] && AGENTS="claude codex cursor agents opencode"
  AGENTS="$(printf '%s' "$AGENTS" | tr ',' ' ' | xargs)"
  [ -n "$AGENTS" ] || die "no skill targets given (--agents)"

  # 先解析全部目标，任何一个不认识就整体失败，不装一半
  SKILL_BASES=""
  for agent in $AGENTS; do
    base="$(agent_skills_base "$agent")" || die "unknown agent: $agent (valid: claude codex cursor agents opencode all)"
    SKILL_BASES="$SKILL_BASES$base
"
  done

  do_install=1
  existing=""
  while IFS= read -r base; do
    [ -n "$base" ] || continue
    { [ -d "$base/csi" ] || [ -d "$base/csi-e2e" ]; } && existing="$existing $base"
  done <<< "$SKILL_BASES"
  if [ -n "$existing" ] && [ "$ASSUME_YES" -eq 0 ]; then
    # 通过管道运行（curl | bash）时 stdin 被脚本占用，从 /dev/tty 读回答
    if [ -t 0 ]; then
      read -r -p "    skills already present under:$existing — overwrite? [y/N] " answer
    else
      read -r -p "    skills already present under:$existing — overwrite? [y/N] " answer < /dev/tty || answer=""
    fi
    case "$answer" in y|Y|yes|YES) ;; *) do_install=0 ;; esac
  fi

  if [ "$do_install" -eq 1 ]; then
    for agent in $AGENTS; do
      base="$(agent_skills_base "$agent")"
      info "$agent → $base"
      install_skill csi-skill.tar.gz "$base/csi"
      install_skill csi-e2e-skill.tar.gz "$base/csi-e2e"
    done
  else
    info "skipped (kept existing)"
  fi
fi

# ---------- 4. login autostart ----------

if [ "$NO_AUTOSTART" -eq 1 ]; then
  step "[4/5] Login autostart — skipped (--no-autostart)"
  info "enable later with:  $BIN_PATH autostart on"
else
  step "[4/5] Login autostart"
  _start=$SECONDS
  if "$BIN_PATH" autostart on; then
    ok "login autostart registered ($(fmt_elapsed $((SECONDS - _start))))"
  else
    warn "failed to register login autostart — after reboot run: $BIN_PATH autostart on"
  fi
fi

# ---------- 5. start daemon ----------

if [ "$NO_START" -eq 1 ]; then
  step "[5/5] Start daemon — skipped (--no-start)"
  info "start it later with:  $BIN_PATH start"
else
  step "[5/5] Starting daemon"
  _start=$SECONDS
  if "$BIN_PATH" start; then
    ok "daemon is running ($(fmt_elapsed $((SECONDS - _start))))"
  else
    warn "daemon failed to start — check logs at $INSTALL_DIR/logs/daemon.log"
  fi
fi

# ---------- done ----------

step "Done. Next steps:"
if [ "$NO_EXT" -eq 1 ]; then
  info "1. Install the CSI extension from the Chrome Web Store if you haven't:"
  info "     https://chromewebstore.google.com/detail/csi/mlnlngdpkodcnblmdgdnlaidijaffeol"
else
  info "1. Load the extension in Chrome:"
  info "     chrome://extensions → Developer mode → Load unpacked → select:"
  info "       $EXT_DIR"
fi
info "2. Open the extension popup and confirm it shows 'connected'"
info "3. Check status:  curl -s http://127.0.0.1:10088/status"
echo ""
