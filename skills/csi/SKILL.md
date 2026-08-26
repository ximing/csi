---
name: csi
description: |
  CSI lets AI control the user's real Chrome browser — navigate, click, type, read, screenshot, save as PDF, and interact with any website using the user's actual login sessions. Use this skill whenever the user wants to interact with websites, automate browser tasks, scrape web content, or perform any action requiring a real browser. Also use when the user mentions "browser", "webpage", "open URL", "screenshot", or asks to read/interact with any website. Use even for simple-sounding browser requests — the daemon handles all complexity.
metadata:
  version: "0.6.0"
---

# CSI

Control the user's real Chrome browser (with their login sessions) via a local daemon at `http://127.0.0.1:10088`.

## Tools

| Tool | Args | Returns | Note |
|------|------|---------|------|
| `navigate` | `url`*, `newTab`(bool), `group_title` | `{success, url, tabId, frameId?}` | First call opens a tab — see [Tabs](#tabs-and-the-current-tab). `group_title` sets the group's visible label. Waits for page load (30s timeout) |
| `find_tab` | `url`*, `active`(bool) | `{success, url, tabId, borrowed}` | Re-select a tab **this session** opened; `active:true` borrows the tab the **user** is viewing — see [Tabs](#tabs-and-the-current-tab) |
| `snapshot` | `mode`(compact/interactive/full), `selector`, `max_chars`, `frame` | `{url,title,mode,chars,truncated,tree}` | 默认 compact YAML，可交互带 @e。truncated 时换 interactive 或对容器传 selector。调试才用 full |
| `click` | `selector`* (@e ref or CSS), `frame` | `{success, tag, text}` | Synthetic DOM-level `el.click()` |
| `fill` | `selector`*, `value`*, `frame` | `{success, tag, mode}` | Works on `<input>`/`<textarea>` AND `[contenteditable]` (ProseMirror/Lexical/Slate). `mode` is `"value"` or `"contenteditable"` |
| `evaluate` | `code`* (supports async/await), `frame` | `{type, value}` | `Runtime.evaluate` with `awaitPromise:true` |
| `network` | `cmd`* (start\|stop\|list\|detail), `filter`, `requestId` | request/response data | `detail` returns `{requestId, url, method, status, mimeType, base64Encoded, body}` |
| `mouse_click` | `selector`* (@e ref or CSS), `frame` | `{success, x, y, tag, text}` | Coordinate-level `Input.dispatchMouseEvent` — passes `isTrusted` checks |
| `wait` | 恰好 `text`/`selector`/`url` 之一；`gone`；`timeout_ms`；`interval_ms`；`frame` | `{success,waitedMs,matched}` | 一次调用，扩展内轮询。优先 text 或 CSS；@e 不在表里会立刻失败 |
| `scroll` | 恰好 `selector` / `to` / `direction` 之一；`amount` | `{success,x,y,maxX,maxY}` | page = 0.9 视口。maxY=0 表示不能再往下滚 |
| `hover` | `selector`*, `frame` | `{success,x,y,tag,text}` | CSS :hover 菜单。不是 DOM mouseover |
| `key_type` | `text`* | `{success, length}` | `Input.insertText` — types text at the focused element |
| `send_keys` | `keys`*, `repeat`(1-100) | `{success, dispatched, os}` | `Enter`/`Escape`/`Tab`/`F1-F12`/single letters+digits, modifiers `Alt/Ctrl/Cmd/Meta/Shift/Mod` (`Mod` auto-resolves to Cmd on macOS, Ctrl elsewhere), space-separated combos — see [Special keys](#form-submit--special-keys) |
| `cdp` | `method`*, `params` | raw CDP response | Raw CDP passthrough — what `evaluate` is to JS, `cdp` is to CDP. Low-level escape hatch for cases the tools above don't cover |
| `screenshot` | `format`(png\|jpeg), `quality`(0-100), optional `selector` (@e/CSS), optional `fullPage`, optional `path`, optional `frame` | `{format, path, sizeBytes, mimeType}` | Returns a file path, not base64 — see [Screenshots](#screenshots). `fullPage` and `selector` are mutually exclusive |
| `save_as_pdf` | `paper_format`, `landscape`, `scale`, `print_background`, `file_name`, optional `path` | `{path, sizeBytes, mimeType, pageTitle}` | Render current page → PDF, returns a file path — see [Save as PDF](#save-the-current-page-as-pdf) |
| `upload` | `selector`*, `files`*(string[]) | `{success, selector, fileCount, files}` | `DOM.setFileInputFiles` on a file input |
| `list_tabs` | — | `{success, tabs:[{tabId, url, title, active, groupTitle}]}` | Inspect tabs in the current session |
| `close_tab` | — | `{success, closed, reason?}` | Close the current tab in the session |
| `close_session` | — | `{success, closed}` | Close all tabs in the session — see [Sessions](#sessions) for when to call |
| `list_frames` | — | `{success, frames:[{frameId,parentId,url,name,isolated}]}` | 列当前 tab 全部帧（含顶层）。辅助工具：歧义排查、看 name/完整 URL/isolated。**不是**进框前置步骤 |

`*` marks required args.

### Tabs and the current tab

Single-tab tools (`snapshot`, `click`, `fill`, `screenshot`, `save_as_pdf`) act on the **current tab** — the one you most recently opened with `navigate` or selected with `find_tab`.

- **Opening pages**: use `newTab:true` when pages should coexist (comparing, cross-referencing); omit it to send the current tab to a new URL. On `chrome://` / `edge://` pages, `navigate` always opens a new tab.
- **Going back to an earlier tab**: call `find_tab` to make a tab **you opened earlier in this session** the current one again. Pass the tab's **full URL** — take it from `list_tabs` or the earlier `navigate` result. A bare root domain (`example.com`) may miss a `www.example.com` tab, so prefer the exact URL. By default `find_tab` searches **only this session's own tabs** — it never reaches into the user's other tabs or windows.
- **Acting on a page the user already has open**: pass `active:true` ("use my open X tab" / "the X page I'm viewing"). It **borrows** the tab the user is currently viewing (returns `borrowed:true`); the borrowed tab is operated in place — it is not pulled into the session's tab group.
- If `find_tab` errors with "no tab matching … in this session", the page isn't open in this session — `navigate` with `newTab:true` instead.

```bash
curl -s -X POST http://127.0.0.1:10088/command \
  -d '{"action":"find_tab","args":{"url":"https://www.example.com","active":true},"session":"my-task"}'
```

### Call Format

Every command carries a top-level `session` naming the current task — see [Sessions](#sessions) below. The examples in later sections omit it only for brevity; in real calls always include it. The command format depends on the user's OS.

**macOS / Linux** — inline JSON is fine:

```bash
curl -s -X POST http://127.0.0.1:10088/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"My task"},"session":"my-task"}'
```

Success and failure both come back as HTTP 200 with a JSON body: `{ "success": true, "data": {...} }` or `{ "success": false, "error": "..." }`. Always check the `success` field, not the HTTP status.

**Windows (PowerShell / cmd)** — the shell corrupts non-ASCII characters (Chinese etc.) carried inline in command arguments or pipes; they reach the daemon as `?` and the text is unrecoverable. Send **every** request as a file body instead:

1. Write the JSON body to a **uniquely-named** temp file with your own file-write tool — never with shell `echo`/heredoc, which corrupts non-ASCII the same way. Give **every** request its own filename with a random suffix (e.g. `csi-req-<random>.json`) so concurrent requests never share a file and overwrite each other.
2. POST the file with `curl.exe` — always `curl.exe`, never bare `curl`, which Windows PowerShell aliases to `Invoke-WebRequest`:

```powershell
curl.exe -s -X POST http://127.0.0.1:10088/command -H "Content-Type: application/json" --data-binary "@$env:TEMP\csi-req-<random>.json"
```

3. Delete the temp file as soon as the request returns — don't leave request bodies on disk.

## Sessions

**One task = one session = one tab group.** A `session` collects every tab the task opens into one tab group (`agent:<session>`), so the user sees a single group for "what the agent is doing right now". Pass it as a **top-level field** of the request body (not inside `args`). It defaults to `"default"` if omitted — always set it explicitly.

- **Pick one session name at the task's start, put it on every command, and never switch mid-task — even across different sites.** Switching session names per site is the #1 cause of fragmented tab groups.
- Name it after the **task**, not the site (`camping-research`, `phone-compare`). Use multiple sessions only for genuinely unrelated parallel tasks.
- `group_title` is the human-readable group label — write it in the user's language, on the **first** `navigate` of the task.
- When you create the group (the first `navigate` of a task), tell the user once that this task's pages are collected under group «title», and that you'll close them whenever they ask.

```bash
# First tab: set session + a human label (in the user's language)
curl -s -X POST http://127.0.0.1:10088/command \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"Feature research"},"session":"feature-research"}'
# Another site, same task → same session → joins the same group automatically
curl -s -X POST http://127.0.0.1:10088/command \
  -d '{"action":"navigate","args":{"url":"https://example.org","newTab":true},"session":"feature-research"}'
```

Closing is always user-initiated: call `close_session` only when the user explicitly asks ("close those", "clear the tabs"). It clears the whole group in one call.

## Screenshots

The daemon writes the image to disk and returns `{format, path, sizeBytes, mimeType}` — never base64, since the model can't read raw image bytes. Take the `.path` and open it with the `Read` tool to actually see it.

```bash
# Default: PNG of the visible viewport, daemon picks a temp path
curl ... -d '{"action":"screenshot","args":{}}'
# Options: JPEG quality, element-only via @e/CSS selector, full page, custom output path
curl ... -d '{"action":"screenshot","args":{"format":"jpeg","quality":60}}'
curl ... -d '{"action":"screenshot","args":{"selector":"@e123"}}'
curl ... -d '{"action":"screenshot","args":{"fullPage":true}}'
```

`fullPage` and `selector` are mutually exclusive — do not pass both. A caller-supplied `path` is honored verbatim (parent dirs created, existing file overwritten) — use a unique **absolute** path to avoid clobbering; relative paths resolve against the daemon's cwd, not yours. `save_as_pdf` follows the same rule.

## Prefer snapshot over CSS/JS selectors

`snapshot` returns interactive elements with `@e` refs based on semantic role/name. Use them directly with click/fill — they survive CSS class hash changes that break manually-written selectors.

Do not pass `mode` by default (compact YAML). If the result is `truncated`, retry with `mode=interactive`; if it is still too large, pass `selector` on the container. Use `mode=full` only for debugging.

Fall back to `evaluate` (JS) only when:
- The target has no `@e` ref in the snapshot
- You need attributes not in the snapshot (e.g., `href`)
- You need to dispatch complex event sequences

## Iframes

- 整页 snapshot 里 iframe 仍是一行（不下行），但带 `[ref=@eN]`；跨域行带 `[isolated]`。
- 同域 iframe 行（**没有** `[isolated]`）：对该 `@e` 再 `snapshot`（`selector` 传那个 ref），返回只含那一帧的 YAML，里面的控件带新 `@e`，直接 click/fill。进框后父页旧 `@e` 仍然有效；点父页失败再重拍父页，不要每次进出都重拍。
- 或 `snapshot({frame: "<未截断 URL 子串或 frameId>"})`。嵌套场景已知内层完整 URL 时可跳过中间层。**不要**用行里截到 80 字符的 `src` 当 `frame=`；优先 `@e`。**不要**编造 CDP frameId。
- 之后 click/fill/hover/mouse_click/wait/screenshot **不必**传 `frame`（`@e` 自带帧）；只有 CSS 选择器 / `evaluate` 要进框时才传 `frame=`。
- `[isolated]` 行：本期进不去。src 是完整页面就 `navigate` 进去；否则告诉用户这期不支持跨域框。对 isolated 帧 snapshot/click 会得到 `iframe: cross-origin frame ...`。
- `list_frames` 只在需要排查时用（`frame=` 多命中、看 `name`、看完整 URL / `isolated`），不是每次进框的前置。
- `/status.version` < 0.6.0 或 `extension_tools` 没有 `list_frames`：不要对 iframe `@e` 再 snapshot（旧扩展会拍空壳），退回 `navigate` 进 src。

## Evaluate Tips

- Always use compact `JSON.stringify(data)` — never add `null, 2` formatting. Indentation and newlines can inflate the response several times over, causing truncation during transmission.
- `evaluate` calls share the page's JS realm — re-declaring the same `const`/`let` across two calls throws `SyntaxError`. Wrap in an IIFE for a fresh scope: `(() => { const x = ...; return x; })()`.
- Scroll with `scroll`. Wait for UI with `wait`. `evaluate` is still a last resort.
- `evaluate` (and `cdp`) is an arbitrary code execution channel in the page — that is by design, but use it deliberately.

## Text input — use `fill`

`fill` (selector = CSS or `@e` ref, plus the value) works on `<input>`/`<textarea>` (returns `mode: "value"`) and on `[contenteditable]` rich editors — ProseMirror, TipTap, Lexical, Slate, Quill, etc. (returns `mode: "contenteditable"`), firing the right input events so the page reacts.

`fill` is **clear-and-insert**: existing content is replaced. To append, read the current value via `evaluate`, concatenate, then `fill` with the result.

For plain typing into the already-focused element, `key_type` (`Input.insertText`) also works — but prefer `fill`, which targets a specific element.

## Wait

Wait for text, an element, or a URL with `wait`. Do not write a bash `while` loop plus `evaluate`.

- `timeout_ms` must be less than the daemon tool timeout (default 120s).
- On timeout, read the last URL in the error, then `snapshot`. Do not treat a timeout as success.

## Form submit / special keys

Use `send_keys` to press special keys. `keys` is a space-separated sequence of key combos, each combo being modifiers joined to a key with `+`:

- Keys: `Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, `F1`-`F12`, arrow keys, and single letters/digits (`a`, `5`).
- Modifiers: `Alt`, `Ctrl`, `Cmd`, `Meta`, `Shift`, and `Mod` (auto-resolves to `Cmd` on macOS, `Ctrl` elsewhere).
- `repeat` (1-100, default 1) repeats the whole sequence.

```bash
# Submit a form with Enter
{"action":"send_keys","args":{"keys":"Enter"}}
# Select all + copy
{"action":"send_keys","args":{"keys":"Mod+a Mod+c"}}
# Press Tab three times
{"action":"send_keys","args":{"keys":"Tab","repeat":3}}
```

Alternatively, dispatch a key event programmatically with `evaluate`:

```bash
{"action":"evaluate","args":{"code":"document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"}}
```

## Save the current page as PDF

`save_as_pdf` renders the current page to PDF and returns the file path. All args optional:
- `paper_format`: `letter` (default) \| `a4` \| `legal` \| `a3` \| `tabloid`
- `landscape`: `false` (default)
- `scale`: `1.0` (default), range `[0.1, 2.0]`
- `print_background`: `true` (default) — keep background colors
- `file_name`: override the output file name (default: sanitized page title + `.pdf`)
- `path`: caller-supplied output path; if absent, daemon picks a default under OS temp dir. Prefer absolute; relative is vs the daemon cwd.

`path` semantics match `screenshot`: written verbatim (including `..`), parent dirs auto-created, existing files overwritten.

Decoded PDF cap is 100 MB. Above that the daemon refuses; reduce `scale` or split the page.

## Known limitations

- **Sites that strictly check `event.isTrusted`** (some banking portals, captchas) ignore `click` / `fill` because those fire DOM-level synthetic events (`isTrusted=false`). Use `mouse_click` instead — it dispatches trusted input events at the coordinate level via CDP. For CSS `:hover` menus, use `hover`.
- **Cross-origin iframes**: 0.6 只列出（`[isolated]` / `list_frames` 的 `isolated:true`），进不去；整页型嵌入请 navigate 进 iframe URL。同域 iframe 可直接进入 — see [Iframes](#iframes)。

## If a tool call fails (daemon not ready)

**If a tool call can't reach the daemon (connection refused), start it yourself — don't ask the user. This is safe to run anytime: it no-ops if the daemon is already up.**

After a reboot the installer-registered login autostart should already have run `csi start`. If a tool call still cannot reach the daemon, start it yourself — don't ask the user. `start` is idempotent.

**macOS / Linux:**

```bash
~/.csi/bin/csi start
```

**Windows (PowerShell):**

```powershell
& "$env:USERPROFILE\.csi\bin\csi.exe" start
```

Then retry the tool call. If it still fails — or the browser extension won't connect — check `references/operations.md` for recovery steps, and ask the user to verify the CSI extension is installed and enabled in Chrome (`chrome://extensions`) and shows "connected" in its popup.

Never run `stop` / `restart` / `uninstall` / `autostart on` / `autostart off` automatically — those change the running daemon or the machine's login behavior. If the user complains they wait a round after every boot, tell them to run `csi autostart status` (prints `on` or `off` plus the unit path) and, if they agree, `csi autostart on`. Re-running the installer also turns autostart back on, even after a manual `off`. See `references/operations.md` for anything deeper.
