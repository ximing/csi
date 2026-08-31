---
name: csi
description: |
  CSI lets AI control the user's real Chrome browser — navigate, click, type, read, screenshot, save as PDF, and interact with any website using the user's actual login sessions. Use whenever the user wants to operate, read, or scrape a live website, automate browser tasks, or do anything that needs a real browser with real login state — including when they mention "browser", "webpage", "open URL", or a screenshot of a live site. Do NOT use when the user is only discussing browser internals, frontend code, URL formats, or screenshot concepts without opening a page; when they ask for headless, an isolated profile, or plain HTTP fetching (CSI is not the default there); or when "browser"/"webpage" merely appears in a code review.
metadata:
  version: "0.6.0"
---

# CSI

Drive the user's real Chrome (with their login sessions) via a local daemon: `POST http://127.0.0.1:10088/command` with a JSON body `{"action","args","session"}`. Call format, the response envelope, and the Windows file-body rule: `references/http-transport.md`.

## Default workflow

1. `navigate` to the task page (`newTab:true`).
2. `snapshot` (default compact) — interactive elements carry `@e` refs.
3. Act on refs: `click` / `fill` / `mouse_click` / etc.
4. After any action that changes the page, `wait` for text / selector / url — never sleep, never poll with bash loops.

Prefer `@e` refs over hand-written CSS: they survive class-hash changes. `evaluate` and `cdp` are escape hatches (arbitrary page-side code execution — use deliberately, only when no `@e`/tool covers it).

## Sessions

**One task = one session = one tab group.** Pick a session name at the task's start, pass it as the top-level `session` field on every command, never switch mid-task. Single-tab tools act on the session's current tab — never pass Chrome `tabId` yourself. Borrowed user tabs, `stale_target` recovery, and closing rules: `references/tabs-and-sessions.md`.

## Load references by scenario (never all at once)

| Scenario | Reference |
|---|---|
| First call / curl details / Windows shells / error envelope | `references/http-transport.md` |
| Multiple tabs, reusing the user's open tab, closing tabs | `references/tabs-and-sessions.md` |
| Clicking, filling, typing, waiting, scrolling, uploading | `references/interaction.md` |
| iframes, the `frame` arg, `list_frames` | `references/frames.md` |
| Large output: snapshot truncation, network bodies, evaluate/cdp limits, screenshot/PDF paths | `references/large-results.md` |
| Daemon/extension install, start, recovery, version mismatch | `references/operations.md` |

The index of all 21 tools (which reference details each) is in `references/http-transport.md`.

## Daemon unreachable

If a call gets connection refused, start the daemon yourself — idempotent and safe anytime: `~/.csi/bin/csi start` (Windows: `& "$env:USERPROFILE\.csi\bin\csi.exe" start`), then retry. Anything deeper: `references/operations.md`.
