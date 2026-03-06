# Operations: daemon lifecycle and recovery

Read this only when a tool call can't reach the daemon, or the user explicitly asks to install / start / troubleshoot CSI.

## The daemon

The `csi` binary lives at `~/.csi/bin/csi` (Windows: `%USERPROFILE%\.csi\bin\csi.exe`) and serves a local HTTP + WebSocket daemon on `127.0.0.1:10088`. The port can be overridden with the `CSI_PORT` environment variable (the extension's popup must then point at the same port).

Directory layout under `~/.csi/`:

```
~/.csi/
├── bin/
│   └── csi                      # daemon binary
├── daemon.pid                   # PID of the running daemon
└── logs/
    ├── daemon-2026-03-06.log    # one log file per day (local date)
    └── daemon-2026-03-05.log    # daily rolling — only the last 3 days are kept
```

Logs roll by day and are pruned automatically (3-day retention) — that's where to look when identifying anomalies from earlier runs.

The daemon binds `127.0.0.1` only — it is never reachable from other machines. There is no authentication in v1; loopback binding is the isolation boundary.

## Recovery — what to do when a tool call fails

1. **Daemon not reachable (connection refused)** → start it yourself, don't ask the user. `start` is idempotent: it no-ops if the daemon is already up, and concurrent starts converge to a single daemon (the OS lets only one process bind port 10088).
   - macOS / Linux: `~/.csi/bin/csi start`
   - Windows: `& "$env:USERPROFILE\.csi\bin\csi.exe" start`

   Then retry the tool call.
2. **`command not found` / binary missing** → not installed. Ask the user to run the installer from the project checkout: `bash scripts/install.sh`, then load the built extension in Chrome.
3. **Daemon up but `extension not connected`** → the browser side is missing. Ask the user to:
   - Open `chrome://extensions` and verify the CSI extension is installed and enabled.
   - Open the extension's popup and confirm it shows "connected" (and the correct port if `CSI_PORT` is used).
   - If Chrome was restarted recently, give the service worker a few seconds — the extension reconnects automatically via its reconcile alarm (every 30s).
4. **Anything still broken after a `start` + retry** → don't deep-troubleshoot in-session. Check today's log under `~/.csi/logs/` (`daemon-YYYY-MM-DD.log`, previous days kept for 3 days) for obvious errors and report them to the user.

## Do NOT do automatically

Never run `stop` / `restart` / `uninstall` on your own. They kill the running daemon and any in-flight work by the user or other agent sessions. If a hard restart is genuinely needed, ask the user to run `csi restart` by hand.

Also do not "fix" version mismatches yourself. If `/status` shows the extension is connected but tool calls fail with `unknown tool`, the daemon and extension builds are out of sync — tell the user to rebuild and reload both.

## /status JSON fields

`GET http://127.0.0.1:10088/status` returns:

- `running` (bool) — daemon listening on its port
- `version` (string) — daemon build version
- `extension_connected` (bool) — a WebSocket client (the browser extension) is attached
- `extension_version` (string) — version reported by the extension in its `hello`, empty if none connected
- `uptime_seconds` (int) — seconds since daemon start
- `sessions` (string[]) — names of sessions with live tab state
- `port` (int) — the port the daemon is bound to (10088 unless overridden)

There is also `GET /healthz`, which returns `200 OK` with body `ok` — use it for a cheap liveness probe.

## Timeouts and errors worth knowing

- Tool calls time out after **120s** at the daemon (`tool call timeout (120s)`); `navigate` additionally has a 30s page-load timeout inside the extension.
- Errors are always returned in the HTTP 200 body as `{ "success": false, "error": "..." }` — HTTP status codes are only for transport-level failures.
- The daemon accepts **one extension connection at a time**: if a second Chrome profile connects with the same extension, it kicks the first one off.
