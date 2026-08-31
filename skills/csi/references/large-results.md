# Large results: budgets, pagination, artifacts, file paths

Read this when a result looks truncated, when you need a full network body / full tree / big evaluate result, or before taking screenshots or PDFs.

## The artifact rule (applies everywhere)

Every text-returning tool has a size budget. When the full payload exceeds it, the daemon writes the **complete** content to a file and returns:

```json
{ "truncated": true, "preview": "...", "path": "/tmp/csi-...",
  "sizeBytes": 12345, "mimeType": "..." }
```

`truncated:true` here means **the inline content was omitted and the full content is at `path`** — not data loss. Read `path` with your file tools (paged/grepped) instead of asking for the whole blob inline. Results are never mid-JSON cut into invalid objects: either complete inline, or artifact.

`result_too_large` is only the failure mode when even delivery/persisting failed (transport cap, disk error) — then narrow the request.

## snapshot budgets

- `max_chars` on `compact`/`interactive`: default **24000**, range 1000–80000. `truncated:true` → switch to `interactive`, or scope with `selector`, or filter with `match` (see `interaction.md`).
- `full` mode promises **completeness**, not unlimited inline bytes: ≤80000 chars inline; larger trees become an artifact (complete JSON at `path`). Compare `source_chars` (pre-cut size) vs `returned_chars` to judge scale.
- Refs from an artifact-ed full snapshot are still assigned — the tree json at `path` matches them.

## network

Args: `cmd`* = `start` | `stop` | `list` | `detail`; `filter`; `requestId`.

- Each tab keeps a ring buffer of at most **2000** captured requests; overflow drops the oldest and `list` reports the running `droppedCount` — start capture before the triggering action, and detail interesting requests before they're dropped.
- `list` → `{requests:[...], nextCursor?, droppedCount}`. Paged: `limit` (default 50, max 500); pass the returned `nextCursor` back as `cursor` for the next page.
- `detail` → `{requestId, url, method, status, mimeType, base64Encoded, body, sourceChars?, truncated?}`, governed by `body_mode`:
  - `preview` (default): body capped at 12000 chars, with `sourceChars` + `truncated`.
  - `full`: complete body inline, still capped at 80000 chars.
  - `file`: complete body via artifact — you get `preview` + `path`. Required for bodies over 80000 chars.

## evaluate / cdp budgets

- `max_chars` (default **12000**, max 80000) applies to the **serialized** result. Over budget → artifact (`truncated:true`, `preview`, `path`).
- `JSON.stringify(data)` compactly in `evaluate` — whitespace costs budget.
- To keep examining a big JSON value, page it yourself: return slices (`items.slice(0, 50)`) or counts first, then details — or take the artifact path once and keep it on disk.

## screenshot

Args: `format` (`png`|`jpeg`), `quality` (0–100), `selector` (@e/CSS), `fullPage`, `path`, `frame` → `{format, path, sizeBytes, mimeType}`.

- The daemon writes the image to disk and returns the **path** — never base64. Open `path` with your Read tool to see it.
- `fullPage` and `selector` are mutually exclusive. `fullPage + frame` clips to the iframe element's visible box in the parent viewport, not the child document's full scroll height.
- Default: PNG of the visible viewport, temp-path picked by the daemon.

## save_as_pdf

Args (all optional): `paper_format` (`letter` default | `a4` | `legal` | `a3` | `tabloid`), `landscape`, `scale` (0.1–2.0, default 1.0), `print_background` (default true), `file_name`, `path` → `{path, sizeBytes, mimeType, pageTitle}`. Decoded PDF cap: 100 MB — reduce `scale` or split the page above that.

## The `path` arg (screenshot / save_as_pdf / artifact-carrying tools)

A caller-supplied `path` is written **verbatim**: parent dirs auto-created, existing files overwritten. Always pass a unique **absolute** path — relative paths resolve against the daemon's cwd (often `/` or the user's home when autostarted), not yours. Without `path`, files land in the OS temp dir (`csi-screenshot-<ts>.<ext>`, `csi-<name>-<ts>`, …).
