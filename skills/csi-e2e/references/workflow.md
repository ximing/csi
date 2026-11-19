# Workflow — verifying a case live in the browser

Verification means: execute the case's steps against the real product through the daemon, and iterate until every 【预期】 holds. Everything from the `csi` skill applies (call format, sessions, snapshot first, Windows file-body POST for non-ASCII, HTTP 401 → auth on, read `api_key` from `~/.csi/config.json` and add `Authorization: Bearer <key>`). This file covers what e2e verification adds on top. Suite scripts (`lib/bridge.mjs`) pick the key up from `config.json` automatically.

## Setup

1. Start whatever the case header declares (dev server, backend, seed data). You do this — the replay runner never starts the app.
2. Pick one session name and put it on every call: the same one the suites will use, `e2e-<project-dir-name>` (or set `E2E_SESSION`). Give the first `navigate` a human-readable `group_title` in the user's language.
3. Before the first real run, do a throwaway pass: open the page, `snapshot`, and explore enough to find the elements each step needs. Note candidate stable selectors as you go — you'll need them for solidification (see `suite-translation.md`).

## Techniques

**Snapshot first, evaluate second.** Locate elements via the accessibility tree's `@e` refs during verification — it's the fastest way to find things. But remember `@e` refs are per-snapshot numbering: they are a verification tool, never suite material. When you find the target, also determine its stable selector (aria-label, role+text, id, data-*) and write that in your notes.

**Wait with `wait`, never fixed sleeps.** For live verification, wait for async UI with one `wait` call — do not write a bash `while` + `evaluate` poll:

```bash
curl -s -X POST http://127.0.0.1:10088/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"wait","args":{"text":"保存成功","timeout_ms":15000},"session":"e2e-myproj"}'
```

Live verify uses `wait`. Suite replay may still use `pollUntil` (no model involved). Good wait targets: target text appeared, a loading element gone (`gone:true` + selector), URL substring. If the only way to know is "it usually settles in a second", note that — the suite will encode it as a commented sleep, but try harder first.

**Failure triage order.** When a step fails: `screenshot` (what's actually on screen) → `snapshot` (what the structure is) → `evaluate` (read app state — store, localStorage, DOM attributes). Most failures are one of: element not there yet (wait condition wrong), wrong element (selector matched something else), or real product bug.

**Throttled tabs.** Background tabs throttle timers and rAF. If a debounced save or animation does not happen, extend `wait` — throttled timers fire late, not never. Do **not** send `Page.bringToFront` or `Target.activateTarget` during live verification. That switches the user's tab and, on macOS, can activate Chrome over the app they are using. If the step still cannot be observed, stop and tell the user the page is background-throttled. Replay's `openPage` already focuses once for unattended suite runs; do not add another focus call to compensate.

## Iteration discipline

- The case .md is a living document during verification. Expectation wrong (you now know the real value)? Fix the md. Step missing (the flow needs an extra click)? Add it. The md must stay executable by a human.
- **Product behavior contradicts a reasonable expectation → stop and report.** That is the entire point of testing. Never quietly weaken an expectation to make the run green; mark it 已知限制 only if the user confirms it's accepted behavior.
- Verify the whole case end-to-end at least once without touching the browser in between — pieces passing individually don't prove the flow.

## Definition of done

A case is ready to solidify when:

1. Every scenario passes live, in order, from a clean start (fresh tab, app in the state the header describes).
2. Every wait has a named condition, not a duration.
3. You have a stable selector candidate for every element the steps touch.
4. The case .md on disk matches what you actually executed.
