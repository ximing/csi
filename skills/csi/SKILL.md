---
name: csi
description: |
  CSI lets AI control the user's real Chrome browser — navigate, click, type, read, screenshot, save as PDF, and interact with any website using the user's actual login sessions. Use whenever the user wants to operate, read, or scrape a live website, automate browser tasks, or do anything that needs a real browser with real login state — including when they mention "browser", "webpage", "open URL", or a screenshot of a live site. Do NOT use when the user is only discussing browser internals, frontend code, URL formats, or screenshot concepts without opening a page; when they ask for headless, an isolated profile, or plain HTTP fetching (CSI is not the default there); or when "browser"/"webpage" merely appears in a code review.
metadata:
  version: "0.6.0"
---

# CSI

Drive the user's real Chrome (with their login sessions) via a local daemon: `POST http://127.0.0.1:10088/command` with a JSON body `{"action","args","session"}`. Call format, response envelope, Windows file-body rule: `references/http-transport.md`.

## Tools (21) — pick by goal, read the linked reference for args

| Goal | Tools | Reference |
|---|---|---|
| Navigate / find tabs | `navigate` `find_tab` `list_tabs` | `references/tabs-and-sessions.md` |
| Read & inspect | `snapshot` (`@e` refs, `match`, modes) · `list_frames` · `network` | `references/interaction.md` · `references/frames.md` · `references/large-results.md` |
| Click / fill / upload | `click` `mouse_click` (trusted) `fill` `upload` `scroll` `hover` | `references/interaction.md` |
| Type / keys | `key_type` `send_keys` | `references/interaction.md` |
| Wait (never sleep, never bash-poll) | `wait` | `references/interaction.md` |
| Capture / export | `screenshot` `save_as_pdf` | `references/large-results.md` |
| Escape hatches (arbitrary page-side code — use deliberately, only when nothing else fits) | `evaluate` `cdp` | `references/large-results.md` |
| Close (only when the user asks) | `close_tab` `close_session` | `references/tabs-and-sessions.md` |

## Typical flow

1. `navigate` to the task page (`newTab:true` gives the session its own tab).
2. `snapshot` — interactive elements carry `@e` refs; on big pages, use `match` (role + name) to find the control instead of reading the whole tree.
3. Act on refs (`click` / `fill` / …).
4. After anything that changes the page, `wait` for text / selector / url — never sleep, never bash-poll.

Prefer `@e` refs over hand-written CSS — refs survive class-hash changes. If a call fails with `stale_ref` / `stale_target`, re-`snapshot` (don't replay the action blindly).

## Sessions

**One task = one session = one tab group.** Pick a session name at the task's start, pass it as the top-level `session` field on every command, never switch mid-task. Single-tab tools act on the session's current tab — never pass Chrome `tabId` yourself. Borrowed user tabs, `stale_target` recovery, and closing rules: `references/tabs-and-sessions.md`.

## Daemon unreachable

If a call gets connection refused, start the daemon yourself — idempotent and safe anytime: `~/.csi/bin/csi start` (Windows: `& "$env:USERPROFILE\.csi\bin\csi.exe" start`), then retry. Anything deeper: `references/operations.md`.
