---
name: csi
description: |
  CSI lets AI control the user's real Chrome browser — navigate, click, type, read, screenshot, save as PDF, and interact with any website using the user's actual login sessions. Use whenever the user wants to operate, read, or scrape a live website, automate browser tasks, or do anything that needs a real browser with real login state — including when they mention "browser", "webpage", "open URL", or a screenshot of a live site. Do NOT use when the user is only discussing browser internals, frontend code, URL formats, or screenshot concepts without opening a page; when they ask for headless, an isolated profile, or plain HTTP fetching (CSI is not the default there); or when "browser"/"webpage" merely appears in a code review.
metadata:
  version: "0.7.3"
---

# CSI

Drive the user's real Chrome (with their login sessions) via a local daemon: `POST http://127.0.0.1:10088/command` with a JSON body `{"action","args","session"}`. Call format, response envelope, Windows file-body rule: `references/http-transport.md`.

## Tools (21) — what each does; args live in the linked reference

| Tool | Use it to | Reference |
|---|---|---|
| `navigate` | open a URL (reuses the session's owned tab, or `newTab:true` for a fresh one) | `references/tabs-and-sessions.md` |
| `find_tab` | adopt an open tab — `active:true` borrows the tab the user is looking at (act on it without owning it) | `references/tabs-and-sessions.md` |
| `list_tabs` | list the session's owned tabs (+ a borrowed current target) | `references/tabs-and-sessions.md` |
| `snapshot` | read the page as an accessibility tree — interactive elements get `@e` refs; `match` filters by role/name; modes compact/interactive/full | `references/interaction.md` |
| `list_frames` | list iframes — same-origin frames can be snapshotted and acted into via the `frame` arg | `references/frames.md` |
| `network` | capture and inspect HTTP traffic: list/filter requests, read response bodies | `references/large-results.md` |
| `click` | DOM-level click | `references/interaction.md` |
| `mouse_click` | trusted coordinate-level click (passes `isTrusted` checks) | `references/interaction.md` |
| `fill` | set inputs/textareas **and** rich-text editors (contenteditable: ProseMirror/TipTap/Lexical/…) | `references/interaction.md` |
| `upload` | attach local files to a file input | `references/interaction.md` |
| `scroll` | scroll the page or an element (direction / top / bottom / to element) | `references/interaction.md` |
| `hover` | real mouse-move (opens CSS `:hover` menus) | `references/interaction.md` |
| `key_type` | type text into the focused element | `references/interaction.md` |
| `send_keys` | special keys & shortcuts (`Enter`, `Tab`, `Mod+a`…), repeatable | `references/interaction.md` |
| `wait` | wait for text / selector / url to appear or vanish — never sleep, never bash-poll | `references/interaction.md` |
| `screenshot` | PNG/JPEG of viewport, element, or full page → file | `references/large-results.md` |
| `save_as_pdf` | print the page to a PDF file | `references/large-results.md` |
| `evaluate` | run arbitrary JS in the page (escape hatch — deliberate use only) | `references/large-results.md` |
| `cdp` | raw Chrome DevTools Protocol passthrough (escape hatch — deliberate use only) | `references/large-results.md` |
| `close_tab` | close the session's current **owned** tab (never a borrowed user tab) | `references/tabs-and-sessions.md` |
| `close_session` | close all of the session's owned tabs | `references/tabs-and-sessions.md` |

## Typical flow

1. `navigate` to the task page (`newTab:true` gives the session its own tab).
2. `snapshot` — interactive elements carry `@e` refs; on big pages, use `match` (role + name) to find the control instead of reading the whole tree.
3. Act on refs (`click` / `fill` / …).
4. After anything that changes the page, `wait` for text / selector / url — never sleep, never bash-poll.

Prefer `@e` refs over hand-written CSS — every `selector` arg takes `"@e3"` (from the latest snapshot) or CSS, and refs survive class-hash churn: `{"action":"click","args":{"selector":"@e3"},"session":"my-task"}`. Refs are per-tab and die on navigation — a failed `stale_ref` / `stale_target` means re-`snapshot` first, never blind-replay.

## Sessions

**One task = one session = one tab group.** Pick a session name at the task's start, pass it as the top-level `session` field on every command, never switch mid-task. Single-tab tools act on the session's current tab — never pass Chrome `tabId` yourself. Borrowed user tabs, `stale_target` recovery, and closing rules: `references/tabs-and-sessions.md`.

## Daemon unreachable

If a call gets connection refused, start the daemon yourself — idempotent and safe anytime: `~/.csi/bin/csi start` (Windows: `& "$env:USERPROFILE\.csi\bin\csi.exe" start`), then retry. Anything deeper: `references/operations.md`.
