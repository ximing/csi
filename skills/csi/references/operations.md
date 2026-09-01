# Operations: daemon lifecycle and recovery

Read this only when a tool call can't reach the daemon, or the user explicitly asks to install / start / troubleshoot CSI.

## The daemon

The `csi` binary lives at `~/.csi/bin/csi` (Windows: `%USERPROFILE%\.csi\bin\csi.exe`) and serves a local HTTP + WebSocket daemon on `127.0.0.1:10088`. The port can be overridden with the `CSI_PORT` environment variable (the extension's popup / options page must then point at the same port). Persistent settings live in `~/.csi/config.json` and in the extension **Settings** page (click the icon → Settings): port, log retention, tool timeout, reconnect interval. Changing the port requires a daemon restart (`csi restart` or the options-page button).

Directory layout under `~/.csi/`:

```
~/.csi/
├── bin/
│   └── csi                      # daemon binary
├── config.json                  # port / log retention / tool timeout
├── daemon.pid                   # PID of the running daemon
└── logs/
    ├── daemon-2026-03-06.log    # one log file per day (local date)
    └── daemon-2026-03-05.log    # daily rolling — last N days (default 3)
```

Logs roll by day and are pruned automatically (default 3-day retention, 1–30 via Settings) — that's where to look when identifying anomalies from earlier runs.

The daemon binds `127.0.0.1` only — it is never reachable from other machines. There is no authentication in v1; loopback binding is the isolation boundary (this machine vs the network). `screenshot` / `save_as_pdf` write the caller-supplied `path` as-is; prefer an absolute path. `upload` attaches caller-supplied `files` paths as-is (not limited to ~/Downloads).

## Recovery — what to do when a tool call fails

1. **Daemon not reachable (connection refused)** → start it yourself, don't ask the user. `start` is idempotent: it no-ops if the daemon is already up, and concurrent starts converge to a single daemon (the OS lets only one process bind port 10088). After a reboot, login autostart (if registered) should already have run `csi start`. If the daemon is still down, start it yourself — `start` is idempotent. If the user says this happens after every boot, tell them to run `csi autostart status` and, only if they ask, `csi autostart on`. Never run `autostart on`/`off` yourself. Re-running the installer re-enables autostart even after a manual `off`.
   - macOS / Linux: `~/.csi/bin/csi start`
   - Windows: `& "$env:USERPROFILE\.csi\bin\csi.exe" start`

   Then retry the tool call. If `start` answers `found live process <pid> not responding as csi`, the PID in the stale pid file was recycled by another process — don't kill it yourself, ask the user to run `csi restart`.
2. **`command not found` / binary missing** → not installed. Ask the user to install the prebuilt daemon from GitHub Releases — do not ask them to build from source:
   - macOS / Linux (Chrome Web Store users): `curl -fsSL https://raw.githubusercontent.com/ximing/csi/master/scripts/install.sh | bash -s -- --no-extension`
   - macOS / Linux (sideload): `curl -fsSL https://raw.githubusercontent.com/ximing/csi/master/scripts/install.sh | bash`
   - Windows (Chrome Web Store users): `$env:CSI_NO_EXTENSION='1'; irm https://raw.githubusercontent.com/ximing/csi/master/scripts/install.ps1 | iex`
   - Windows (sideload): `irm https://raw.githubusercontent.com/ximing/csi/master/scripts/install.ps1 | iex`
3. **Daemon up but `extension not connected`** → the browser side is missing. Ask the user to:
   - Prefer the [Chrome Web Store listing](https://chromewebstore.google.com/detail/csi/mlnlngdpkodcnblmdgdnlaidijaffeol). Sideload alternative: `chrome://extensions` → Developer mode → Load unpacked → `~/.csi/extension` (only if they used the Release zip).
   - Open `chrome://extensions` and verify the CSI extension is installed and enabled.
   - Open the extension's popup and confirm it shows "connected" (and the correct port if `CSI_PORT` is used).
   - If Chrome was restarted recently, give the service worker a few seconds — the extension reconnects automatically via its reconcile alarm (default 30s, configurable in Settings).
4. **Anything still broken after a `start` + retry** → don't deep-troubleshoot in-session. Check today's log under `~/.csi/logs/` (`daemon-YYYY-MM-DD.log`) for obvious errors and report them to the user.
5. **Everything works but the daemon may just be old** → `curl -s http://127.0.0.1:10088/status` and look at `update_available` (only present once an update check has been cached, e.g. by the daily update task). If it is `true`, tell the user a newer release exists (`latest_version`) and suggest they run `csi update` — never run it yourself (see below).

## Do NOT do automatically

Never run `stop` / `restart` / `csi uninstall` / `csi update` / `autostart on` / `autostart off` on your own. `stop`/`restart` kill the running daemon and any in-flight work. `csi uninstall` goes further — it stops the daemon, removes login autostart and the daily update task, and deletes `~/.csi` entirely. `csi update` replaces the binary and restarts the daemon — whether to upgrade is the user's call. `autostart on`/`off` change whether the daemon comes back at login — that needs the user's OK. If a hard restart is genuinely needed, ask the user to run `csi restart` by hand. If they want login autostart, ask them to run `csi autostart on`.

Also do not "fix" version mismatches yourself:

1. If the error contains `does not implement` (including `"list_frames"` or `"frame"`, need ≥ 0.6.0) → tell the user to upgrade the extension (Chrome Web Store, or reload `~/.csi/extension`). Do not start/stop/restart.
2. If the error is `unknown tool` and `/status.version` is < 0.6.0 → tell the user to upgrade the daemon (GitHub Release / installer).
3. 不要自己「对齐版本」。

## /status JSON fields

`GET http://127.0.0.1:10088/status` returns:

- `running` (bool) — daemon listening on its port
- `pid` (int) — daemon process id (start/stop use it for identity checks — don't kill it yourself)
- `version` (string) — daemon build version
- `extension_connected` (bool) — a WebSocket client (the browser extension) is attached
- `extension_version` (string) — version reported by the extension in its `hello`, empty if none connected
- `extension_tools` (string[] | null) — tool names the extension implements (null = pre-0.4 extension that didn't report)
- `uptime_seconds` (int) — seconds since daemon start
- `sessions` (string[]) — names of sessions with live tab state
- `port` (int) — the port the daemon is bound to (10088 unless overridden)
- `update_available` (bool) — a newer release exists. Only present when an update check has been cached (by the daily update task or a `csi update --check` run); absent means "no check result yet", not "up to date"
- `latest_version` (string) — newest release version from that cached check; present and absent together with `update_available`

There is also `GET /healthz`, which returns `200 OK` with body `ok` — use it for a cheap liveness probe.

## Timeouts and errors worth knowing

- Tool calls time out after **120s** by default at the daemon (`tool call timeout (120s)`); the value is 5–600s via Settings / `POST /config`. `navigate` additionally has a 30s page-load timeout inside the extension.
- Errors are always returned in the HTTP 200 body as `{ "success": false, "error": "..." }` — HTTP status codes are only for transport-level failures.
- The daemon accepts **one extension connection at a time**: if a second Chrome profile connects with the same extension, it kicks the first one off.
