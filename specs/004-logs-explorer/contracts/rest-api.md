# REST + WebSocket contract: `backend-logs`

Base prefix `/logs` (added to the `app-gateway` regex; `/logs` page loads with `Accept: text/html` go to the SPA via
`$spa_page`). Every body DTO is `@Valid`; all sizes clamped server-side; errors use `GlobalExceptionHandler`'s shape.
List endpoints return `LogLineSummary` (no `raw`, only role/template/column fields); full data on `GET …/lines/{id}`.

## Sources and structure

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/logs/sources` | - | `LogSourceSummary[]` (counts, sizes, inputs with status) |
| `POST` | `/logs/sources` | `{ name, rawMode, privacyMode }` | `LogSource` 201 + one-time `pushToken` |
| `PATCH` | `/logs/sources/{id}` | `{ name?, retention?, privacyMode? }` | `LogSource` |
| `GET` | `/logs/sources/{id}/delete-impact` | - | `{ lines, comments, pinned }` for the confirmation dialog |
| `DELETE` | `/logs/sources/{id}` | - | 204 (removes lines, comments, pins, views); 409 while an input is LOADING (pause first) |
| `POST` | `/logs/sources/{id}/push-token` | - | `{ pushToken }` (regenerate; old token invalid) |
| `GET` | `/logs/sources/{id}/structure` | - | `LogStructure` |
| `PUT` | `/logs/sources/{id}/structure` | `LogStructure` | `{ structure, rebuilds: RebuildJob[] }` - changes to type / search mode / levels start background jobs (R6) |
| `POST` | `/logs/structure/preview` | `{ inputDraft }` | detected `LogStructure` + 20 sample lines (wizard step 2, before anything is stored) |
| `GET` | `/logs/sources/{id}/fields/{label}/invalid?limit=` | - | lines whose value did not fit the type (≤ 100) |

## Inputs

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/logs/server-files?dir=` | - | entries under `/logs` only (traversal rejected 400) |
| `POST` | `/logs/uploads` | `{ fileName, size, sha256 }` | `{ uploadId, chunkSize }` |
| `PUT` | `/logs/uploads/{uploadId}/chunks/{n}` | binary ≤ 40 MB | 204 |
| `GET` | `/logs/uploads/{uploadId}` | - | `{ receivedChunks[] }` (resume) |
| `POST` | `/logs/sources/{id}/inputs` | `{ kind, config, confirmDuplicate? }` | `LogInput` 201; 409 `DUPLICATE_FILE` (same fingerprint) unless `confirmDuplicate` |
| `POST` | `/logs/sources/{id}/inputs/{inputId}/{pause\|resume\|retry}` | - | `LogInput` |
| `DELETE` | `/logs/sources/{id}/inputs/{inputId}?deleteLines=` | - | 204 |
| `POST` | `/logs/sources/{id}/push` | NDJSON ≤ 10 MB, header `X-Log-Push-Token` | 202 `{ accepted }`; 401 bad token; 413 too large; **503 + `Retry-After`** when busy (clarification Q4) |

OpenSearch `config`: `{ url, index, query, timeRange, mode: IMPORT|IMPORT_FOLLOW|IN_PLACE, pageSize ≤ 5000,
maxPagesPerSecond ≤ 20, intervalSeconds ≥ 5, username?, password? }` - `password` is write-only; responses carry
`credentialsSet: boolean`.

## Querying (body = `LogQuery`, see log-query.md)

| Method | Path | Response |
|---|---|---|
| `POST` | `/logs/sources/{id}/lines` | `{ lines: LogLineSummary[], total, nextCursor, tookMs }` (`limit` ≤ 500) |
| `GET` | `/logs/sources/{id}/lines/{lineId}` | `LogLine` full (all fields + raw / `rawUnavailable`) |
| `GET` | `/logs/sources/{id}/lines/{lineId}/context?before=&after=` | input-order neighbours (each ≤ 100) |
| `POST` | `/logs/sources/{id}/groups` | `{ parentPath, level, cursor, limit }` + LogQuery → `GroupNode[]` + `nextCursor` |
| `POST` | `/logs/sources/{id}/patterns` | `Pattern[]` (filtered), `POST …/patterns/{pid}/lines` → paged lines |
| `POST` | `/logs/sources/{id}/histogram` | `{ buckets: [{ from, to, byLevel }] }` (≤ 120) |
| `POST` | `/logs/sources/{id}/minimap` | body: LogQuery + `condition: Pill?` (default ERROR/WARN) → `{ buckets: 200 × { matches, error, warn }, sampled }` (even sample above 5 M matches) |
| `GET` | `/logs/sources/{id}/structures` | `LineStructures`: the structures among the lines, "seen in X %" per field (FR-045 as amended) |
| `POST` | `/logs/sources/{id}/structures` | body `LogQuery` → the same, plus `matching` per structure for that query |
| `PATCH` | `/logs/sources/{id}/structures/{structureId}` | `{ name, template }` (blank = automatic name / the source's template) → 204 |
| `POST` | `/logs/sources/{id}/structures/{structureId}/move` | `{ name }` → new `SourceView` 201 holding that structure's lines (COPY mode) |
| `POST` | `/logs/sources/{id}/fields/values` | per field top values + presence % (window: latest 10,000 matches) |
| `POST` | `/logs/sources/{id}/fields/{label}/stats` | `{ exact: bool, p50, p95, p99, min, max, distribution[24] }` or top 10 + distinct |
| `GET` | `/logs/sources/{id}/trace?lineId=` | lines sharing the CORRELATION role value, time-sorted (≤ 2,000) |
| `POST` | `/logs/sources/{id}/compare` | `{ a, b }` → field-by-field rows with `differs` |

## Selection, comments, saved views

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/logs/sources/{id}/selection/export?format=ndjson\|json\|md\|html` | `{ lineIds[] ≤ 10,000 }` or `{ allMatching: LogQuery, except[] }` | streamed file, never truncated (redaction applied by the frontend builders for md/html/json; ndjson is raw unless privacy ≠ SHOW) |
| `POST` | `/logs/sources/{id}/selection/pin` | same selector | `{ pinned }` |
| `POST` | `/logs/sources/{id}/selection/comment` | selector + `{ text }` | `{ commented }` |
| `GET` | `/logs/sources/{id}/lines/{lineId}/comments` | - | `LogComment[]` |
| `POST` | `/logs/sources/{id}/lines/{lineId}/comments` | `{ path, text, authorProfileId }` | `LogComment` 201 (pins the line) |
| `DELETE` | `/logs/sources/{id}/comments/{commentId}` | - | 204 |
| `GET/POST/DELETE` | `/logs/sources/{id}/views[/{viewId}]` | `SavedView` | saved views (≤ 100/source) |

## WebSocket `/ws/logs`

Server → client JSON events; the client re-fetches what it shows (no payload-driven list mutation):

- `{ type: "lines-added", sourceId, count, newestTs }` → explorer: if scrolled to top, refetch first page; else
  increment the "N new lines" pill.
- `{ type: "input-progress", sourceId, inputId, status, lines, bytes, totalBytes }` → sources list, Load screen.
- `{ type: "structure-changed", sourceId, rebuilding: [labels] }` → field "rebuilding" state, refetch structure.
- `{ type: "rebuild-done", sourceId, label }`.
- `{ type: "comment-changed", sourceId, lineId }`.
