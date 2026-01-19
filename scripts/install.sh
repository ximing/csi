#!/usr/bin/env bash
#
# cdp-bridge installer
#
# Builds the daemon (Go) and the Chrome extension (TS), installs the daemon
# binary to ~/.cdp-bridge/bin/, and optionally installs the Claude Code skill
# to ~/.claude/skills/cdp-bridge/.
#
# Usage: bash scripts/install.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="$HOME/.cdp-bridge"
SKILL_DIR="$HOME/.claude/skills/cdp-bridge"

echo "==> cdp-bridge install"
echo "    project root : $PROJECT_ROOT"
echo "    daemon dir   : $INSTALL_DIR"
echo ""

# --- 1. Build daemon ----------------------------------------------------------

echo "==> [1/4] Building daemon (Go)"

if ! command -v go >/dev/null 2>&1; then
  echo "ERROR: 'go' not found in PATH. Install Go (https://go.dev/dl/) and re-run." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR/bin"

(
  cd "$PROJECT_ROOT/daemon"
  go build -o "$INSTALL_DIR/bin/cdp-bridge" ./cmd/cdp-bridge
)

echo "    built: $INSTALL_DIR/bin/cdp-bridge"
echo ""

# --- 2. Build extension -------------------------------------------------------

echo "==> [2/4] Building Chrome extension (npm)"

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: 'npm' not found in PATH. Install Node.js (https://nodejs.org/) and re-run." >&2
  exit 1
fi

(
  cd "$PROJECT_ROOT/extension"
  npm install
  npm run build
)

echo "    built: $PROJECT_ROOT/extension/dist"
echo ""

# --- 3. Load extension in Chrome (manual step) --------------------------------

echo "==> [3/4] Load the extension in Chrome (manual step)"
echo ""
echo "    1. Open  chrome://extensions  in Chrome"
echo "    2. Enable  Developer mode  (top-right toggle)"
echo "    3. Click  Load unpacked  and select:"
echo "         $PROJECT_ROOT/extension/dist"
echo "    4. Open the extension popup and confirm it shows 'connected'"
echo ""

# --- 4. Install Claude Code skill (optional) ----------------------------------

echo "==> [4/4] Claude Code skill"
echo ""

if [ -d "$SKILL_DIR" ]; then
  echo "    skill already present at $SKILL_DIR"
  read -r -p "    Overwrite with this checkout's skill/? [y/N] " answer
  case "$answer" in
    y|Y|yes|YES)
      rm -rf "$SKILL_DIR"
      cp -R "$PROJECT_ROOT/skill" "$SKILL_DIR"
      echo "    updated: $SKILL_DIR"
      ;;
    *)
      echo "    skipped (kept existing)"
      ;;
  esac
else
  read -r -p "    Copy skill/ to $SKILL_DIR ? [Y/n] " answer
  case "$answer" in
    n|N|no|NO)
      echo "    skipped — to install later:  cp -R \"$PROJECT_ROOT/skill\" \"$SKILL_DIR\""
      ;;
    *)
      mkdir -p "$(dirname "$SKILL_DIR")"
      cp -R "$PROJECT_ROOT/skill" "$SKILL_DIR"
      echo "    installed: $SKILL_DIR"
      ;;
  esac
fi

echo ""
echo "==> Done. Next steps:"
echo "    - Start the daemon:   $INSTALL_DIR/bin/cdp-bridge start"
echo "    - Check status:       curl -s http://127.0.0.1:10088/status"
echo "    - Smoke test:         curl -s -X POST http://127.0.0.1:10088/command \\"
echo "                            -H 'Content-Type: application/json' \\"
echo "                            -d '{\"action\":\"navigate\",\"args\":{\"url\":\"https://example.com\",\"newTab\":true},\"session\":\"smoke\"}'"
