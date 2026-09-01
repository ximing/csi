# Interaction: snapshot, refs, clicks, typing, waiting

Read this before acting on page content. All `selector` args accept an `@e<num>` ref (from `snapshot`) or a CSS selector. `@e` refs carry their frame — don't pass `frame` with them (frames: `frames.md`).

## snapshot

Args: `mode` (`compact` | `interactive` | `full`, default `compact`), `selector`, `match`, `max_chars`, `frame` → `{url, title, mode, chars, source_chars, returned_chars, matches?, truncated, tree}`.

- `mode`: default `compact` returns a YAML accessibility tree; `interactive` lists interactive elements with **up to two named ancestor groups** (dialog/form/row/…), so same-named buttons in different dialogs stay distinguishable; `full` is the whole tree (debugging only — budget rules in `large-results.md`).
- Don't pass `mode` by default. If the result is `truncated`, retry with `mode=interactive`; still too large → pass `selector` on the container and re-shoot just that subtree.
- `match` — deterministic filter by accessible role/name: `{role?, name*, exact?}` (`exact` defaults `true`; substring requires explicit `false`; case-insensitive). It **only filters output** — it never clicks or picks for you. All hits are returned (the response adds `matches: N`); zero hits is a successful empty result, not an error. Use it to pass judgement to yourself instead of eyeballing a whole tree.
- If it still doesn't fit: budgets and artifact fallback are in `large-results.md`.

## @e refs

Interactive elements come with `[ref=@eN]`. Use refs directly with `click` / `fill` / `mouse_click` / `hover` / `scroll` — they survive CSS class-hash churn that breaks hand-written selectors. Refs are per-tab; a ref from one tab is meaningless in another. If a call fails `stale_ref` (the page navigated or the node was replaced), `snapshot` again and use the fresh refs — same for `unknown_ref` (you never snapshotted this tab).

## Click

- `click` — synthetic DOM-level `el.click()` → `{success, tag, text}`. Sites that strictly check `event.isTrusted` (some banking portals, captchas) ignore it; then use `mouse_click`.
- `mouse_click` — coordinate-level `Input.dispatchMouseEvent` → `{success, x, y, tag, text}`. Passes `isTrusted` checks; needs the element visible in the viewport (scroll first if needed).
- `hover` — real `mouseMoved` (CSS `:hover` menus) → `{success, x, y, tag, text}`. Not a DOM `mouseover`.

## Typing and forms

- `fill` args: `selector`*, `value`* → `{success, tag, mode}`. Works on `<input>`/`<textarea>` (`mode:"value"`) **and** `[contenteditable]` rich editors — ProseMirror/TipTap/Lexical/Slate/Quill (`mode:"contenteditable"`) — firing the right input events. It is **clear-and-insert**: to append, read the current value via `evaluate`, concatenate, then `fill` the result.
- `key_type` args: `text`* — plain typing into the already-focused element (`Input.insertText`). Prefer `fill` when you can name the element.
- `send_keys` for special keys; args: `keys`*, `repeat` (1–100, default 1) → `{success, dispatched, os}`. `keys` is a space-separated sequence of combos; each combo is modifiers joined to a key with `+`.
  - Keys: `Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, `F1`–`F12`, arrows, single letters/digits.
  - Modifiers: `Alt`, `Ctrl`, `Cmd`, `Meta`, `Shift`, `Mod` (`Mod` auto-resolves to Cmd on macOS, Ctrl elsewhere).

```json
{"action":"send_keys","args":{"keys":"Enter"}}
{"action":"send_keys","args":{"keys":"Mod+a Mod+c"}}
{"action":"send_keys","args":{"keys":"Tab","repeat":3}}
```

- `upload` args: `selector`*, `files`* (string[]) → `{success, selector, fileCount, files}`. Attaches the given local paths to a file input (`DOM.setFileInputFiles`). Paths used as-is — project files in scope, not sandboxed to `~/Downloads`.

## wait

Args: exactly one of `text` / `selector` / `url`; plus `gone`, `timeout_ms` (default 15000, max 120000), `interval_ms`, `frame` → `{success, waitedMs, matched}`.

- One call polls inside the extension — never write a bash `while` loop plus `evaluate`.
- `frame` scopes `text`/`selector` polling to that frame (frameId or URL substring); `url` always matches the tab URL. `@e` refs carry their own frame — don't pass `frame` with them.
- `timeout_ms` must stay below the daemon tool timeout (120 s default).
- On timeout, read the last URL in the error message, then `snapshot` to see where the page actually went — a timeout is a failure, not a soft pass.
- An `@e` selector not in this tab's ref table fails immediately — re-snapshot.

## scroll

Args: exactly one of `selector` / `to` (`top`|`bottom`) / `direction` (`up|down|left|right`); `amount` (number or `"page"`, direction-only, default `page` = 0.9 viewport) → `{success, x, y, maxX, maxY}`. `maxY=0` after scrolling down means the bottom is reached.

## evaluate / cdp (escape hatches)

- `evaluate` args: `code`* (async/await OK, `awaitPromise:true`), `max_chars`, `frame` → `{type, value}`. Always compact `JSON.stringify(data)` output — `null, 2` pretty-printing can inflate results several-fold into truncation. Calls share the page realm: re-declaring the same `const`/`let` across calls throws `SyntaxError` — wrap in an IIFE: `(() => { const x = ...; return x; })()`.
- `cdp` args: `method`*, `params`, `max_chars` — raw CDP command passthrough. Returned `data` is always a JSON object: plain objects passed through, `null`/`undefined` → `{}`, arrays/primitives → `{value: ...}`.
- Both are arbitrary code execution in the page — by design, but use them deliberately, only when `snapshot`/`@e`/other tools don't cover the need. Result-size budgets: `large-results.md`.
