# Data Model: Alfred for Claude (MCP server)

The MCP server stores nothing. Every entity below is Alfred's existing wire shape (types imported from `frontend/src/app/core/models/*`), plus the reply shapes the server builds for Claude.

## Alfred entities (read through the existing API)

| Entity | Type (frontend model) | Key fields used | Notes |
|---|---|---|---|
| Call | `CallRecord` (`call.model.ts`) | `id, method, url, original_url, timestamp, duration_ms, request{headers,body}, response{status,headers,body}, error, state, service_name, parentCallId, parentSeq, timing, source` | `source`: `internal` = inbound, `external` = outbound. Inbound live calls live in a ring buffer (1500) - may disappear; cycle copies persist. |
| Call detail | `CallDetail` | `request, response` | fetched per part (`CallDetailPart`). |
| Session cycle | `SessionCycle` | `id, name, createdAt, assignedTo, status (RECORDING|PAUSED), reliveRunId` | Relive-run cycles never record. Several cycles may record at once. |
| Spacer | `CycleSpacer` | `id, cycleId, label, afterCallId, anchorTimestamp, createdAt` | anchored to call ABOVE; null/null = top. |
| Comment | `Comment` | `id, callId, block, lineIndex, lineText, comment, createdAt` | Claude's comments: `comment` starts with `🤖 Claude: `. |
| DB summary | `CallDbSummary` | `statementCount, failedCount, dbMicros, flags[], complete, endedEarly` | missing ⇒ not captured. |
| Statement | `CapturedStatement` | `id, seq, kind, sql, table, params, outcome, durationMicros, offsetMicros, callers, origin` | |
| Capture | `CallDbCapture` | `summary, transactions, supplierMarkers, statements, analysis` | assembled from statements pages for the overview; from `/export` for exports. |
| Analysis | `CallDbAnalysis` | `time, queries, summary, findings` | computed by `analyzeCapture` - never by MCP-own code. |
| Redaction | `Redaction` | as `/redactions` | applied to every export via `redactCalls`. |

## Server-side reply shapes

- **CallRow**: `{id, direction: 'inbound'|'outbound', method, url, status|null, durationMs, time, project?, error?}` - default list row; replaced by the selection when `fields`/`paths` given.
- **Selection result**: `{[fieldOrPath]: value}` plus `missing: string[]` for unknown names/paths.
- **BodyChunk**: `{text, offset, length, totalLength, nextOffset|null, contentType?, binary?: true}` - binary/compressed bodies report type and size only.
- **CycleStory**: `{cycle, totalCalls, offset, nextOffset, items: (StoryCall | StorySpacer)[]}`; `StoryCall = CallRow + {n, comments[], db?: {summary, findings[] (no notes)}}`.
- **CopyReport**: `{added, skipped, notFound: string[]}`.
- Every read reply carries `masked: boolean, maskedValues: number`.
- **ExportResult**: `{path, bytes, calls, redactedValues}` or `{needsPath: true, suggestedName}`.
- **ToolError**: `{error: 'unreachable'|'not_found'|'invalid'|'backend', message, tried?}`.

## Session state (in-memory, per server process = per Claude session)

- **SessionSettings**: `{maskSecrets: boolean (initial from ALFRED_MCP_MASK, default false), exportFolder: string | null (absolute, existing directory)}`. Never persisted; changed only by `session_settings`.

## Validation rules

- Ids: non-empty strings; statement ids integers.
- Limits: list `limit ≤ 200` (matches backend clamp), statement list `≤ 100`, body chunk `≤ 15,000` chars, `calls[] ≤ 200`, `paths ≤ 20`, comment `≤ 4,000` chars.
- `export_calls.path`: absolute, or relative to the session `exportFolder`; with neither, the tool asks (`needsPath`). Refuses an existing file unless `overwrite: true`; parent directory must exist.
- `add_spacer.afterCallId` / `move_spacer.afterCallId`: must be a call currently in that cycle, or `"top"`.

## State transitions

- Cycle status: `PAUSED --start_recording--> RECORDING --stop_recording--> PAUSED`. Same-state requests return `changed: false`. A Relive-run cycle stays `PAUSED`.
