# Suite translation — from verified case to e2e/suites/<name>.mjs

Solidification is translation, not transcription: you convert the verified interaction into code that replays it deterministically. Read this before writing or fixing a suite.

## Structure

Every suite follows the same shape (see `templates/e2e/suites/smoke.mjs` for a complete minimal example):

```js
// <name> suite（叙述版见 e2e/cases/<name>.md）
import { evaluateJS } from '../lib/bridge.mjs'
import { openPage, pollUntil } from '../lib/env.mjs'

export default async function run({ assertEq }) {
  await openPage('https://app-under-test/')   // URL from the case header

  async function s1() { /* scenario 1 */ }
  async function s2() { /* scenario 2 */ }

  const scenarios = [['1 场景名', s1], ['2 场景名', s2]]
  for (const [name, fn]) {
    try { await fn(); console.log(`  ✓ ${name}`) }
    catch (e) { console.error(`  ✗ ${name}`); throw e }  // fast-fail
  }
}
```

The runner discovers `suites/*.mjs` automatically — same base name as the case md, default-exported `run({ assertEq })`.

## The rules

### 1. No `@e` refs — ever

`snapshot` renumbers refs every call. `@e37` captured during verification is meaningless in replay. Every interaction in a suite goes through a stable selector, chosen in this order:

1. `[aria-label="..."]`, `[role="..."]`, button/link text
2. `data-*` attributes
3. stable `id`
4. semantic class names (`.xcell-editor`, not `.css-1x2y3z`)
5. structural selectors (`.form > div:nth-child(2) input`) — last resort, add a comment saying why

Translation example: verification did `click @e12` (the 保存 button) → suite does `cmd('click', { selector: 'button[aria-label="保存"]' })`.

`click`/`fill`/`mouse_click` all accept CSS selectors directly. For anything more complex (reading state, custom events, scrolling), use `evaluateJS`.

### 2. Reading state

- All reads go through `evaluateJS(code)` — the bridge wraps your code in an async IIFE, so use `return`. The value must be JSON-serializable.
- Keep output compact: never `JSON.stringify(x, null, 2)` — indentation inflates the response and risks truncation.
- `evaluate` shares the page's JS realm; top-level `const`/`let` from an earlier call still exist. Wrap multi-statement reads in their own block or IIFE.
- Object key order in returned values is **not stable** across the wire (observed: alphabetical). The runner's `assertEq` normalizes via `canon()` — this is why raw `assert(JSON.stringify(a) === ...)` is forbidden in suites.

### 3. Waiting

- Every wait is `pollUntil(predCode, label, timeoutMs?)` with a page-side predicate: `pollUntil("!document.querySelector('.loading')", 'S2 loading 消失')`.
- Fixed `sleep()` only where no predicate exists (CSS animation, debounce window you can't observe) — and always with a comment explaining why.

### 4. Assertions

- `assertEq(actual, expected, label)` for everything comparable; label format `"S<场景号> <语义>"` (`'S1 标题与 h1'`) so a failure says where it died.
- Substring checks (flash messages, exported text): define a local `assertIncludes(hay, needle, label)`.
- Assert the *values the case declares* — display text, stored raw values, URLs. Don't assert implementation details the case never mentions.

### 5. Sessions and isolation

- `openPage()` first thing in `run()`: it ensures the daemon, closes leftover tabs **of the e2e session only** (an intentional exception to the "close_session is user-initiated" rule — it never touches the user's other tabs), navigates, retries once with a fresh session name if the daemon's tab binding went stale, and brings the tab to front.
- Scenarios within a suite run in order and may depend on earlier ones' state — say so in a comment. Suites must be independent of *each other*: any suite can run alone via `node e2e/run.mjs <name>`.
- Pages that throttle timers in background tabs: `openPage` already brings to front; after any in-page `location.reload()` bring to front again.

### 6. Evidence screenshots

For key steps or known-flaky assertions, leave a screenshot: `await shot('e2e/artifacts/login-s2.png')` — paths are resolved from the suite file (the daemon's cwd is unrelated, and the daemon writes `path` verbatim), parents auto-created. Don't screenshot every step; they accumulate.

### 7. Document deviations

If the suite can't do exactly what the case says (timing snapshot, harness limitation), implement the semantically equivalent check and write a 偏离说明 comment in the suite explaining what differs and why it's equivalent. The case md stays the human truth; the suite explains its deltas.

## After writing

```bash
node e2e/run.mjs <name>   # green
node e2e/run.mjs <name>   # green again — twice to rule out flakiness
node e2e/run.mjs          # full run still green
grep -n '@e' e2e/suites/<name>.mjs   # must be empty
```
