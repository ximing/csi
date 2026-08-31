# HTTP transport: call format, shells, envelope

Read this before your first daemon call, or whenever a call shape or error envelope is in question.

## Request

Every tool call is one HTTP POST:

```
POST http://127.0.0.1:10088/command
Content-Type: application/json

{"action": "<tool>", "args": {...}, "session": "my-task"}
```

- `action` (required): tool name — see the index below.
- `args` (optional): tool arguments. Never include `_`-prefixed keys (`_session`, `_tabId`, `_tabIds`) — the daemon injects and overwrites them.
- `session` (optional, top level — not inside `args`): the task's session name; defaults to `"default"`. Always set it explicitly (see `tabs-and-sessions.md`).
- Request body cap is 64 MB total — large `fill.value` / `evaluate.code` / `cdp.params` are bounded by this.

## Response envelope

Success and failure both come back as HTTP 200 with a JSON body — **always check `success`, never the HTTP status**:

```json
{ "success": true, "data": {...} }
{ "success": false, "error": "navigate: url is required" }
```

Failures may add optional `code` / `details` fields (ignore them only if you must — they carry recovery info):

```json
{ "success": false, "error": "session target tab 123 is no longer available",
  "code": "stale_target", "details": { "tabId": 123, "session": "my-task", "nextTabId": 122 } }
```

Error codes worth branching on:

| code | Meaning | Recovery |
|---|---|---|
| `stale_target` | The session's current tab is gone (user closed it). Daemon does not replay for you | `list_tabs`; if `details.nextTabId` present that's a surviving owned tab — otherwise `navigate` or `find_tab(active:true)`. Never blindly replay the failed action |
| `no_session_target` | Session has no current tab | `navigate` first, or `find_tab(active:true)` to borrow the user's tab |
| `unknown_ref` | `@e` not in this tab's ref table | `snapshot` first |
| `stale_ref` | `@e` predates the current page load | `snapshot` again, use fresh refs |
| `result_too_large` | Result could not be delivered at all (transport cap / artifact persist failed) | Narrow the request; see `large-results.md` |

Uncoded errors: `extension not connected` (see `operations.md`), `unknown tool: x` (daemon older than the tool — check `/status.version`), `tool call timeout (120s)`.

## Timeouts

- Daemon tool timeout: 120 s default (5–600 s configurable). Any `wait.timeout_ms` must stay below it.
- `navigate` additionally has a 30 s page-load timeout inside the extension.

## curl — macOS / Linux

Inline JSON is fine:

```bash
curl -s -X POST http://127.0.0.1:10088/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"My task"},"session":"my-task"}'
```

## curl — Windows (PowerShell / cmd)

The shell corrupts non-ASCII characters (Chinese etc.) passed inline in arguments or pipes; they reach the daemon as `?` and are unrecoverable. Send **every** request as a file body:

1. Write the JSON body to a **uniquely-named** temp file with your own file-write tool — never shell `echo`/heredoc, which corrupts non-ASCII the same way. Give every request its own filename (`csi-req-<random>.json`) so concurrent calls never share a file.
2. POST it with `curl.exe` — always `curl.exe`, never bare `curl` (PowerShell aliases that to `Invoke-WebRequest`):

```powershell
curl.exe -s -X POST http://127.0.0.1:10088/command -H "Content-Type: application/json" --data-binary "@$env:TEMP\csi-req-<random>.json"
```

3. Delete the temp file as soon as the request returns.

## Tool index (21)

Which reference details each tool:

| Tool | Details in |
|---|---|
| `navigate` | `tabs-and-sessions.md` |
| `find_tab` | `tabs-and-sessions.md` |
| `list_tabs` | `tabs-and-sessions.md` |
| `close_tab` | `tabs-and-sessions.md` |
| `close_session` | `tabs-and-sessions.md` |
| `snapshot` | `interaction.md` (+ budgets: `large-results.md`) |
| `click` | `interaction.md` |
| `mouse_click` | `interaction.md` |
| `hover` | `interaction.md` |
| `fill` | `interaction.md` |
| `key_type` | `interaction.md` |
| `send_keys` | `interaction.md` |
| `wait` | `interaction.md` |
| `scroll` | `interaction.md` |
| `upload` | `interaction.md` |
| `list_frames` | `frames.md` |
| `evaluate` | `interaction.md` (+ budgets: `large-results.md`) |
| `cdp` | `interaction.md` (+ budgets: `large-results.md`) |
| `network` | `large-results.md` |
| `screenshot` | `large-results.md` |
| `save_as_pdf` | `large-results.md` |
