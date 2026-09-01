# Frames: iframes, the `frame` arg, list_frames

Read this when the page contains iframes, or a `frame=` value doesn't match.

## How iframes appear in snapshot

A whole-page snapshot keeps each iframe as **one line** (it doesn't descend into it) but tags it with `[ref=@eN]`; cross-origin frames are tagged `[isolated]`.

## Entering a same-origin frame — two ways

1. **Re-snapshot the iframe's `@e`**: call `snapshot` with `selector` set to the iframe's ref. The result is the YAML of just that frame, whose controls carry fresh `@e` refs — click/fill them directly. After entering, the parent page's old `@e` refs still work; only re-snapshot the parent if a parent-side ref fails, not on every hop.
2. **`frame=` on `snapshot`**: pass a frameId or an **untruncated URL substring** of the frame. With nested frames, knowing the inner frame's full URL lets you skip the middle layer. Never feed the 80-char-truncated `src` shown in the tree line into `frame=`, and never invent a CDP frameId — prefer the `@e` route.

## After entering

`click` / `fill` / `hover` / `mouse_click` / `wait` / `screenshot` on an `@e` ref need **no** `frame` — the ref carries it. `frame=` is only needed when a **CSS selector** or an `evaluate` `code` must run inside the frame (cross-origin frames fail with the cross-origin error below).

`frame` exists on: `snapshot`, `click`, `fill`, `evaluate`, `mouse_click`, `wait`, `hover`, `screenshot`.

## Cross-origin (`[isolated]`) frames

Not supported this version. If the frame's `src` is a full page, `navigate` straight to that URL instead; otherwise tell the user cross-origin embedding isn't supported yet. Snapshot/click into an isolated frame returns `iframe: cross-origin frame "<url>" is not supported yet. If it is a full page, navigate to its URL.`

## list_frames — diagnostics only

`list_frames` (no args) → `{success, frames:[{frameId, parentId, url, name, isolated}]}` lists every frame of the current tab including the top frame. Use it to disambiguate (`frame=` matched 2+ frames, or you need a frame's `name` / full URL / `isolated` flag). It is **not** a required step before entering a frame.

## frame= matching errors

- 0 hits → `iframe: no frame matching "<value>"`
- ≥2 hits → `iframe: multiple frames match "<value>": <url1>, …` — check `list_frames`.
- Same-origin frame unloaded / context gone → `iframe: frame is gone; run snapshot again`.
- `selector` and `frame` pointing at different frames → `iframe: selector and frame do not refer to the same frame`.

## Version gate

If `/status.version` < 0.6.0 or `/status.extension_tools` lacks `list_frames`, do **not** re-snapshot an iframe `@e` (the old extension returns an empty shell) — fall back to `navigate`-ing into its `src`.
