# `LogQuery` - the storage-neutral query model

One model is sent by the frontend and translated per backend: SQL now (`SqliteLogQueryTranslator`), OpenSearch DSL
for in-place sources (`OpenSearchQueryTranslator`), Mongo later. The UI never sees storage syntax.

```json
{
  "pills": [
    { "op": "EQ",  "field": "externalService", "value": "Sabre" },
    { "op": "NEQ", "field": "log.level", "value": "DEBUG" },
    { "op": "GT",  "field": "timeTaken", "value": 6000 },
    { "op": "BETWEEN", "field": "@timestamp", "from": "2026-10-01T19:00Z", "to": "2026-10-01T20:30Z" },
    { "op": "EXISTS", "field": "error" },
    { "op": "NOT_EXISTS", "field": "inboundCallId" },
    { "op": "TEXT", "value": "anotrav" },
    { "op": "SELECTION", "lineIds": ["…"] }
  ],
  "timeRange": { "from": 0, "to": 0 },
  "sort": { "field": "@timestamp", "dir": "DESC" },
  "cursor": "opaque",
  "limit": 200
}
```

Ops: `EQ, NEQ, GT, LT, BETWEEN, EXISTS, NOT_EXISTS, TEXT, SELECTION` (≤ 50 pills; `SELECTION` ≤ 10,000 ids).
Comparisons follow the field's **type** (FR-029 #5). `NEQ` and `NOT_EXISTS` include lines without the field.

## Query bar grammar (frontend `logs-query-parse.ts`, identical to the mock)

| Typed | Pill |
|---|---|
| `field:value` | EQ |
| `-field:value` | NEQ |
| `field:*` / `-field:*` | EXISTS / NOT_EXISTS |
| `field>v`, `field<v` | GT / LT |
| `"text"` or any other text | TEXT |
| histogram drag | BETWEEN on the TIME role field |
| "Show selection only" | SELECTION |

## SQLite translation

| Op | SQL (field N; typed fields use `t<N>`, others `f<N>`) |
|---|---|
| EQ | `t<N> = ?` / `f<N> = ?` |
| NEQ | `(f<N> IS NULL OR f<N> <> ?)` |
| GT/LT/BETWEEN | `t<N> > ?` … (typed only; 400 on string fields) |
| EXISTS / NOT_EXISTS | `f<N> IS NOT NULL` / `IS NULL` |
| TEXT (≥ 3 chars) | `rowid IN (SELECT rowid FROM fts_<src> WHERE fts_<src> MATCH ?)` |
| TEXT (< 3 chars) or over NONE fields | `(f<a> LIKE ? OR …)` - flagged `slow: true` in the response |
| SELECTION | `line_id IN (…)` |
| cursor | keyset `(ts_ms, line_id) < (?, ?)` for DESC |

## OpenSearch translation (in-place)

EQ → `term`, NEQ → `bool.must_not term`, GT/LT/BETWEEN → `range`, EXISTS → `exists`, TEXT → `wildcard`
`*value*` on Text fields (case-insensitive), cursor → `search_after`, groups → `terms` aggregation on the level
field with `top_hits` size 1 for the head line. Patterns and minimap are not available in IN_PLACE mode (the UI
hides those controls with a note).
