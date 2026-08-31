# Tabs and sessions

Read this when a task spans multiple tabs, when the user asks you to use a tab they already have open, when you hit `stale_target`, or before closing anything.

## Sessions

**One task = one session = one tab group.** A `session` collects every tab the task opens into one tab group (`agent:<session>`), so the user sees a single group for "what the agent is doing right now". Pass `session` as a **top-level field** of the request body (not inside `args`); it defaults to `"default"` — always set it explicitly.

- Name the session after the **task** (`camping-research`, `phone-compare`), not the site. Never switch session names mid-task — even across sites; per-site sessions fragment the tab group and split tab ownership.
- Use multiple sessions only for genuinely unrelated parallel tasks.
- `group_title` (on the task's first `navigate`) is the human-readable group label — write it in the user's language. Tell the user once that this task's pages live under that group and you'll close them whenever they ask.

```bash
curl -s -X POST http://127.0.0.1:10088/command \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"Feature research"},"session":"feature-research"}'
```

## The current target

Single-tab tools (`snapshot`, `click`, `fill`, `screenshot`, `save_as_pdf`, …) act on the session's **current tab** — the one most recently opened with `navigate` or selected with `find_tab`. Do **not** pass Chrome `tabId` yourself; the daemon remembers it per session.

- `navigate` args: `url`*, `newTab` (bool), `group_title` → `{success, url, tabId, frameId?}`. Waits for page load (30 s timeout).
- Use `newTab:true` when pages must coexist (comparing, cross-referencing). Omit it to send the session's **owned** current tab to a new URL.
- If the current target is a **borrowed** user tab, `navigate` (even without `newTab`) opens a **new owned tab** and never rewrites the user's URL. On `chrome://` / `edge://` pages, `navigate` always opens a new tab.

## find_tab — re-select or borrow

`find_tab` args: `url`*, `active` (bool) → `{success, url, tabId, borrowed}`.

- **Going back to a tab you opened earlier**: pass the tab's **full URL** (from `list_tabs` or the earlier `navigate` result). A bare root domain (`example.com`) may miss `www.example.com`. By default `find_tab` searches **only this session's own tabs** — it never reaches into the user's other tabs. Error "no tab matching … in this session" means it isn't open here — `navigate` with `newTab:true` instead.
- **Acting on a page the user already has open**: pass `active:true` ("use my open X tab"). It **borrows** the tab the user is currently viewing — result has `borrowed:true` — and makes it the session's current target. Subsequent snapshot/click stay on it until you `navigate` or `find_tab` again. The borrowed tab is **not** pulled into the session's tab group and is **never** closed by `close_tab` / `close_session`.

```bash
curl -s -X POST http://127.0.0.1:10088/command \
  -d '{"action":"find_tab","args":{"url":"https://www.example.com","active":true},"session":"my-task"}'
```

## list_tabs

No args → `{success, tabs:[{tabId, url, title, active, groupTitle}], currentTarget?}`. `tabs` lists **owned** tabs only; a borrowed current target appears separately as `currentTarget`.

## Closing — always user-initiated

- `close_tab` → closes the current **owned** tab. On a borrowed target it returns `{closed:false, reason}` and closes nothing.
- `close_session` → closes the session's **owned** tabs (the whole group) in one call; borrowed user tabs survive.

Call either only when the user explicitly asks ("close those", "clear the tabs").

## stale_target — recovery, not replay

If the session's current tab was closed (by the user, or externally), the next call fails with `code:"stale_target"` and `details` like `{tabId, session, nextTabId?}`. `nextTabId` appears when another owned tab of this session is still alive.

- **Do not replay the failed action** — its target is gone.
- Run `list_tabs` to see what's left, then `navigate` or `find_tab` (including `active:true` if the user points you at a tab they have on screen), and rebuild refs with a fresh `snapshot` before acting again.
