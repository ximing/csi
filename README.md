# CSI

**English** | [简体中文](README.zh-CN.md)

**CSI** — Ctrl+Shift+I，每个程序员都按过的 DevTools 快捷键；也是 Crime Scene Investigation——AI 勘查浏览器案发现场。

Let AI (Claude Code and other agents) control your **real Chrome browser** — navigate, click, type, read pages, take screenshots, save PDFs — using your actual login sessions. No automation-flagged browser, no separate profile: the agent drives the Chrome you already use.

## Architecture

```
AI client (Claude Code skill)
        │  HTTP POST /command  (JSON)
        ▼
┌─────────────────────────────┐
│  daemon (Go)                │  127.0.0.1:10088
│  HTTP server + WS server    │  loopback only, no auth (v1)
└─────────────────────────────┘
        ▲  WebSocket /ws  (extension is the WS client, auto-reconnects)
        │
┌─────────────────────────────┐
│  Chrome extension (MV3 SW)  │  runs in your real Chrome
│  executes tools via CDP     │  debugger API on your tabs
└─────────────────────────────┘
```

- The daemon is an HTTP server for AI clients and a WebSocket server for the extension. The extension connects out to the daemon; only one extension connection is kept at a time.
- Every command carries a `session` name; each session's tabs are collected into a Chrome tab group (`agent:<session>`) so you can see at a glance what the agent is doing.
- Screenshots and PDFs are written to disk by the daemon and returned as file paths.

The full wire contract is in [docs/protocol.md](docs/protocol.md).

## Quick start

Prerequisites: Chrome. Everything else is downloaded prebuilt from [GitHub Releases](https://github.com/ximing/csi/releases) — no Go/Node needed.

**1. Install** — daemon → `~/.csi/bin`, extension → `~/.csi/extension`, Claude Code skills → `~/.claude/skills/csi` + `~/.claude/skills/csi-e2e`; the daemon is started at the end:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/ximing/csi/master/scripts/install.sh | bash
```

```powershell
# Windows (PowerShell 5.1+)
irm https://raw.githubusercontent.com/ximing/csi/master/scripts/install.ps1 | iex
```

Both installers accept the same flags: `--no-start` / `-NoStart` (don't start the daemon), `--no-skill` / `-NoSkill` (don't touch `~/.claude/skills`), `-y` / `-Yes` (don't prompt before overwriting an existing skill install). Pin a specific release with `CSI_VERSION=v0.1.0`.

**2. Load the extension in Chrome** (manual step): `chrome://extensions` → Developer mode → Load unpacked → select `~/.csi/extension`. Open the extension popup and confirm it shows "connected".

**3. Check everything is wired up** (the installer already started the daemon; `csi start` is idempotent — safe to run anytime):

```bash
curl -s http://127.0.0.1:10088/status
# → {"running":true,"extension_connected":true,...}
```

**4. Drive the browser:**

```bash
curl -s -X POST http://127.0.0.1:10088/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"Demo"},"session":"demo"}'

curl -s -X POST http://127.0.0.1:10088/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"snapshot","args":{},"session":"demo"}'

curl -s -X POST http://127.0.0.1:10088/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"screenshot","args":{},"session":"demo"}'
```

The installer also copies two Claude Code skills to `~/.claude/skills/`: `csi` (browser control — used automatically whenever you ask Claude Code to interact with websites) and `csi-e2e` (e2e test suites — see below).

## MCP server

`csi mcp` runs a stdio MCP server exposing all 17 browser tools. It is a thin proxy: each tool call is forwarded to the local daemon's `POST /command` (same `CSI_PORT`, default 10088), so the daemon must be running (`csi start`).

Mount it in Claude Code:

```bash
claude mcp add csi -- ~/.csi/bin/csi mcp
```

Each tool also takes an optional top-level `session` argument (default `"default"`) that maps to the daemon's session field. `screenshot`/`save_as_pdf` return a file path — view it with the Read tool.

## E2E testing skill

The installer also drops a second skill, `csi-e2e`, into `~/.claude/skills/`. It turns natural-language browser scenarios into replayable e2e regression suites — driven by the same daemon, no test framework, no dependencies beyond Node ≥ 18:

1. **Describe** — the model writes `e2e/cases/<name>.md` in your project: a header declaring the URL under test and how to start the app, then numbered steps each with a machine-checkable 【预期】.
2. **Verify** — it executes the case live in your real Chrome via the daemon, iterating until every expectation holds.
3. **Solidify** — what passed gets translated into `e2e/suites/<name>.mjs` (plain Node scripts talking to the daemon over HTTP).
4. **Replay** — `node e2e/run.mjs [suite...]`, no model involved.

Ask Claude Code to "write an e2e test for X" in any web project and the skill kicks in. See [skills/csi-e2e/SKILL.md](skills/csi-e2e/SKILL.md) for the full workflow.

## Coding Agent Skills

CSI ships [Agent Skills](https://code.claude.com/docs/en/claude-code/skills) in [`skills/`](./skills) that teach coding agents to drive your real Chrome browser:

| Skill | Purpose |
| --- | --- |
| [`csi`](./skills/csi) | Drive the user's real Chrome via the local daemon — navigate, click, type, screenshot, save PDF, with real login sessions. |
| [`csi-e2e`](./skills/csi-e2e) | Turn natural-language browser scenarios into replayable e2e regression suites (describe → verify → solidify → replay). |

The skills are plain `SKILL.md` documents (plus `references/` and templates) with no runtime dependency, so the same files work across coding tools. Installation differs by tool — if you use more than one, install separately for each.

### Claude Code

```bash
/plugin marketplace add ximing/csi
/plugin install csi@csi
```

Or manually: `cp -r skills/csi skills/csi-e2e ~/.claude/skills/`

### Codex App / Codex CLI

This repository doubles as a Codex plugin marketplace (see [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json)), so no official listing is needed:

```bash
codex plugin marketplace add ximing/csi
codex plugin add csi@csi
```

### Cursor

The plugin manifest lives at [`.cursor-plugin/plugin.json`](.cursor-plugin/plugin.json). In Cursor Agent chat run `/add-plugin csi`, or search for `csi` in the plugin marketplace. Manually, copy the skill directories into `.cursor/skills/` of your project.

### Grok Build CLI

Install from xAI's official plugin marketplace (listing in review at [xai-org/plugin-marketplace#266](https://github.com/xai-org/plugin-marketplace/pull/266)):

```bash
grok plugin install csi@xai-official --trust
```

### Kimi Code

```text
/plugins install https://github.com/ximing/csi
```

Then start a fresh session (`/new`) so the plugin loads.

### OpenCode

Add the plugin to `opencode.json` (global or project-level); it registers `skills/` through OpenCode's plugin system:

```json
{
  "plugin": ["csi@git+https://github.com/ximing/csi.git"]
}
```

### Pi

```bash
pi install git:github.com/ximing/csi
```

The package manifest in [`package.json`](package.json) declares the `skills/` directory for Pi's native skill discovery.

> Note: the shell/PowerShell installers in [Quick start](#quick-start) copy the skills to `~/.claude/skills/` (Claude Code's location). For the tools above, use the per-tool install commands instead — the underlying skill files are identical. The daemon and Chrome extension from the installer are still required; skills only teach the agent how to talk to the daemon.

## Tools

17 tools: `navigate`, `find_tab`, `snapshot` (accessibility tree with `@e` refs), `click`, `fill` (inputs + contenteditable), `evaluate`, `network`, `mouse_click` (trusted coordinate-level clicks), `key_type`, `send_keys`, `cdp` (raw passthrough), `screenshot`, `save_as_pdf`, `upload`, `list_tabs`, `close_tab`, `close_session`. See [docs/protocol.md](docs/protocol.md) §4 for the exact contract.

## Directory layout

```
csi/
├── docs/protocol.md        # the single source of truth for the wire protocol
├── daemon/                 # Go daemon (HTTP + WS server, session state)
│   └── cmd/csi/
├── extension/              # Chrome MV3 extension (TypeScript, service worker)
│   └── dist/               # build output — load this in chrome://extensions
├── skills/csi/             # coding-agent skill: browser control (SKILL.md + references/)
├── skills/csi-e2e/         # coding-agent skill: describe→verify→solidify→replay e2e suites
├── .claude-plugin/         # plugin manifests: Claude Code, Codex, Cursor, Kimi, OpenCode, Pi
│   └── ...                 # (.claude-plugin/ .codex-plugin/ .agents/ .cursor-plugin/ .kimi-plugin/ .opencode/)
├── scripts/                # installers: install.sh (macOS/Linux), install.ps1 (Windows)
└── .github/workflows/      # release.yml — tag v* → cross-build daemon + extension → GitHub Release
```

## Development

```bash
# daemon
cd daemon
go test ./...
go build -o ~/.csi/bin/csi ./cmd/csi

# extension
cd extension
npm install
npm run build        # outputs extension/dist — reload in chrome://extensions

# release (pushes a tag → workflow cross-builds everything and drafts a Release)
git tag v0.1.0 && git push origin v0.1.0
```

Protocol changes: edit `docs/protocol.md` first, then update both sides. The protocol file is the contract; implementations must follow it.

Port: default `10088`, override with the `CSI_PORT` environment variable (set the same port in the extension popup). Click the extension icon → Settings to open the options page: view daemon status, change the port / log retention days / tool timeout, and adjust the auto-reconnect interval.

## Security notes

- The daemon binds `127.0.0.1` only; there is no authentication in v1 — loopback is the isolation boundary. Anything running as your user can drive your browser.
- `evaluate` and `cdp` are arbitrary code execution channels in the page. That is a designed capability, not a bug — treat skill prompts accordingly.

## Roadmap

- **DirectCDPBackend**: connect to [obscura](https://github.com/h4ckf0r0day/obscura) — a Rust headless browser with a built-in CDP server. The daemon would talk directly to its CDP WebSocket, no Chrome extension needed, for fully headless automation alongside the current real-Chrome mode.
