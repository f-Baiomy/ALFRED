# Data Model: Logs Explorer

Domain records live in `backend-logs` `domain.model` (pure, Jackson allowed). Storage shown for the SQLite adapter;
a later MongoDB adapter maps the same records to documents.

## LogSource

| Field | Type | Rules |
|---|---|---|
| id | String (ULID) | server-assigned |
| name | String | 1–80 chars, unique |
| structureId | String | → LogStructure |
| rawMode | `COPY` \| `OFFSET` | `REDACT_AT_LOAD` privacy forces `COPY` |
| privacyMode | `SHOW` \| `MASK` \| `REDACT_AT_LOAD` | FR-043 |
| remoteMode | `IMPORT` \| `IN_PLACE` \| null | null for non-OpenSearch sources |
| retentionMaxBytes | long | 0 = keep everything (default); otherwise 100 MB–500 GB. No age-based retention |
| lineCount, storedBytes, unparsedCount | long | maintained per batch |
| pushTokenHash | String | SHA-256 of the push token; token shown once on create/regenerate |
| createdAt, updatedAt | Instant | |

SQLite: `log_source`. Per source: `ll_<id>` (lines), `fts_<id>` (FTS5 trigram, external content), `lg_<id>` (group
nodes), `lp_<id>` (patterns).

## LogStructure

| Field | Type | Rules |
|---|---|---|
| id | String | hash of the sorted field-path set (same structure ⇒ same settings, FR-016) |
| fields | List<FieldDef> | ≤ 300 |
| groupLevels | List<GroupLevel> | ordered, ≤ 8, each fieldPath must exist |
| template | String | ≤ 500 chars, `{label}` tokens, ` · ` segments |
| columns | List<String> | field labels toggled into the table (FR-018), ≤ 30 |
| defaultDataView | `TABLE` \| `JSON` | |
| timeZone | String (IANA) | default = server zone; validated with `ZoneId.of` |
| overflowPaths | List<String> | fields seen past 900 searchable fields (first 1,000 listed): raw line / JSON only |

`fields` is every field any line of the source has had (≤ 900 stored, ≤ 2,000 in all); lines may each have their
own structure (FR-045 as amended).

## LineShape (a structure among the lines)

| Field | Type | Notes |
|---|---|---|
| id | int | 1, 2, ... per source; shown as "S‹id›", filter `structure:S2` |
| name | String \| null | user name; null = named after its most telling field |
| template | String \| null | own summary template; null = the source's |
| fields | List<int> | field indexes of its first line (what later lines are compared with) |
| lineCount, fieldCounts | long, Map<int, long> | maintained per batch; "seen in X %" = Σ fieldCounts / Σ lineCount |

A line joins the structure it shares most fields with if the overlap (Jaccard) is ≥ 0.7, else starts a new one; past
100 structures it joins the nearest. SQLite: `ls_<id>`, and `ll_<id>.shape`.

## FieldDef

| Field | Type | Rules |
|---|---|---|
| index | int | column number N (`f<N>`, `t<N>`), never reused |
| path | String | full flattened path, e.g. `message.context.timeTaken` |
| label | String | display name (path without wrapper prefixes), unique within structure |
| type | `DATE` \| `DATETIME` \| `NUMBER` \| `STRING` \| `BOOLEAN` | FR-011 |
| typeSource | `AUTO` \| `USER` | |
| format | String | date pattern + zone, number unit, boolean words; ≤ 100 chars |
| matchRate, invalidCount | double, long | detection / re-type statistics |
| searchMode | `EXACT` \| `TEXT` \| `NONE` | EXACT ⇒ B-tree index on `t<N>` (typed) or `f<N>`; TEXT ⇒ FTS column |
| role | `TIME` \| `LEVEL` \| `CORRELATION` \| `MESSAGE` \| `SERVICE` \| `DURATION` \| `STATUS` \| `REQUEST_BODY` \| `RESPONSE_BODY` \| `ERROR` \| null | a role may be on several fields (FR-045 as amended) |
| roleRank | int | 1..n order among a role's fields; each line uses the first it has; 0 = no role |
| sensitive | boolean | used by MASK / REDACT_AT_LOAD |
| duplicateOf | String \| null | unpacked JSON-in-text equal to another subtree; default searchMode NONE |
| firstSeenLine | long | > sample ⇒ "new field found" notice |

## GroupLevel

`fieldLabel`, `sort` ∈ `TIME_ASC | TIME_DESC | ERRORS_DESC | LINES_DESC | MAX_DURATION_DESC | ID_ASC`.

**Placement rule** (domain `GroupKeyer`, single implementation): `ids[i]` = value of level i (null if absent).
Present count k = number of non-null ids. If ids[0] is null ⇒ "No ‹level-1 field›" bucket. If a gap exists before
the last present id ⇒ placed under the node of the ids before the first gap, with `missingLevel = first gap`.
Otherwise level = k, `group_path` = ids[0..k-1] joined by `\u0001`, parent path = ids[0..k-2].

## LogLine (stored row) / LogLineSummary (list DTO)

| Field | Type | Notes |
|---|---|---|
| lineId | String | `<inputId>:<byteOffset>` or remote `_id` (clarification Q1) |
| inputId, byteOffset | String, long | |
| ts | long (epoch ms) | from the TIME role field, else ingest time |
| level | String | from the LEVEL role field |
| groupLevel, groupPath, missingLevel | int, String, String? | |
| patternId | long | |
| pinned | boolean | commented / pinned lines skip retention |
| unparsed | boolean | invalid JSON; only `raw` is set |
| fields | Map<label, value> | **summary DTO**: only role fields + template fields + chosen columns; **full DTO**: all |
| raw | String | full DTO only; COPY: stored; OFFSET: read via `RawLineReaderPort`, or `rawUnavailable` reason when the file changed |
| commentCount | int | summary badge |

## GroupNode (grouped view DTO)

`path`, `level`, `id` (this level's value), `headLine` (LogLineSummary or null ⇒ placeholder), `siblings`
(LogLineSummary[] — same level, same ids, after the head), `skippedChildren` (lines with `missingLevel`),
`childCount`, `descendantCount`, `firstTs`, `lastTs`, `errorCount`, `maxDuration`, `nextCursor`.

## Pattern

`id`, `template`, `count`, `worstLevel`, `sampleLineIds` (≤ 3).

## LogInput

| Field | Type | Notes |
|---|---|---|
| id | String | |
| sourceId | String | |
| kind | `UPLOAD` \| `SERVER_FILE` \| `FOLLOW` \| `PUSH` \| `OPENSEARCH` | |
| config | per-kind record | path; OpenSearch url/index/query/timeRange/mode/limits (credentials in SecretStore) |
| fingerprint | String | name + size + SHA-256(first 1 MB) for the same-file warning |
| status | `QUEUED` \| `LOADING` \| `DONE` \| `FOLLOWING` \| `WAITING` \| `PAUSED` \| `FAILED` \| `RAW_UNAVAILABLE` | |
| position | long / String | byte offset, or OpenSearch `search_after` cursor; saved in the batch transaction |
| progress | lines, bytes, totalBytes, startedAt | |
| lastError | String | no line content |

**State transitions**: `QUEUED → LOADING → DONE`; `QUEUED → FOLLOWING ⇄ WAITING` (file missing); any running state
`→ PAUSED → (previous)`; any `→ FAILED` (retry returns to `QUEUED` from saved position); OFFSET-mode file changed ⇒
`RAW_UNAVAILABLE` (lines stay searchable; raw shows the reason).

## LogComment

`id`, `sourceId`, `lineId`, `path` (field path or `""` for whole line, FR-042), `text` (1–4,000 chars),
`authorProfileId` (plain string id of an ALFRED profile, no compile-time coupling to `backend-profiles` - same as
session-cycles' `assignedTo`; a deleted profile renders as "deleted profile"), `createdAt`. Creating a comment sets `pinned=1` on the line (and copies the line in IN_PLACE mode).

## SavedView

`id`, `sourceId`, `name` (1–80), `pills` (≤ 50), `timeRange`, `view` (`LINES|GROUPED|PATTERNS`), `columns`,
`levelSorts`, `leafSort`, `dataView`.

## Selection (frontend only)

`Set<lineId>` + `lastPick`; "select all matching" is represented as `{ allMatching: LogQuery, except: Set }` so bulk
actions on millions of lines are executed server-side (export, pin, comment) without sending ids.
