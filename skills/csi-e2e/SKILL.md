---
name: csi-e2e
description: |
  Turn natural-language browser scenarios into replayable e2e regression suites driven by the csi daemon (real Chrome). Workflow: write a case .md describing the scenario → verify it live in the browser → solidify into a suite .mjs → replay anytime with `node e2e/run.mjs`. Use when the user asks to write e2e / end-to-end / browser regression tests, convert a manual acceptance scenario or bug reproduction into a replayable script, scaffold an e2e/ test directory for a web project, or run/replay existing e2e suites. Requires the csi daemon + Chrome extension (see the `csi` skill); for general one-off browsing or scraping use `csi` instead.
metadata:
  version: "0.7.3"
---

# csi-e2e

Describe browser test scenarios in plain language, verify them in a real Chrome browser via the csi daemon, then solidify what passed into replayable scripts. The result lives in the target project as a plain `e2e/` directory — no test framework, no dependencies beyond Node ≥ 18.

## Prerequisites

- The csi daemon is running and the Chrome extension is connected. Check with `curl -s http://127.0.0.1:10088/status` — `extension_connected` must be `true`. If the daemon is down, start it yourself: `~/.csi/bin/csi start` (Windows: `& "$env:USERPROFILE\.csi\bin\csi.exe" start`); it is idempotent.
- Node ≥ 18 (the replay scripts use global `fetch`).
- You know how to drive the browser through the daemon — read the `csi` skill first if you haven't. Everything there (call format, sessions, snapshot/@e refs, Windows file-body POST) applies to the verification step.

## The four steps

### 1. Scaffold (first time in a project)

Copy `templates/e2e/` from this skill into the target project root as `e2e/`:

```
e2e/
├── run.mjs           # runner — node e2e/run.mjs [suite...] (default: all)
├── lib/bridge.mjs    # daemon HTTP wrapper (cmd / evaluateJS / bringToFront)
├── lib/env.mjs       # ensureDaemon / openPage / pollUntil / sleep / shot
├── cases/            # natural-language case descriptions (.md)
└── suites/           # solidified replay scripts (.mjs, same base name as the case)
```

If the project already has `e2e/run.mjs`, skip this step and reuse what's there.

### 2. Describe — write `e2e/cases/<name>.md`

Turn the user's scenario into a case file: a header declaring the URL under test and how to start the app, then numbered scenarios where every step has a machine-checkable 【预期】 (expected). Read `references/case-format.md` before writing your first case.

### 3. Verify — execute it live in the browser

Drive a real browser through the daemon and execute every step of the case, iterating until all expectations hold. This is where you discover the stable selectors and wait conditions the suite will need. Read `references/workflow.md` for verification techniques and iteration discipline.

**If the product's actual behavior contradicts a reasonable expectation, stop and report it to the user — that's a bug finding, not something to write around.**

### 4. Solidify & replay — translate to `e2e/suites/<name>.mjs`

Translate the verified interaction into a suite script using `lib/` helpers, then prove it:

```bash
node e2e/run.mjs <name>     # must be green
node e2e/run.mjs <name>     # run again — twice green to rule out flakiness
```

Read `references/suite-translation.md` before translating — it has the rules that keep suites from rotting (most importantly: **`@e` refs from snapshots must never end up in a suite**).

From then on the suite replays with `node e2e/run.mjs [suite...]` — no model involved.

## Session discipline

Use one session name for all e2e work in a project — the bridge defaults to `e2e-<project-dir-name>` and suites inherit it. During live verification, pass the same session name explicitly on every daemon call. All e2e tabs collect into one Chrome tab group, so the user can see what the tests are doing; `openPage` closes leftover tabs from previous runs of the e2e session only (never the user's own tabs).

## Which reference to read when

| Situation | Read |
|---|---|
| Writing a case .md | `references/case-format.md` |
| Verifying a case in the browser / a step won't pass | `references/workflow.md` |
| Translating to a suite .mjs / fixing a rotted suite | `references/suite-translation.md` |
| Daemon unreachable, extension not connected | the `csi` skill's `references/operations.md` |
