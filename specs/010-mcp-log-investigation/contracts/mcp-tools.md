# Contract: MCP tools (mcp-server)

Every tool: masked like bodies (`mask` input as today), `scope` input where cross-call
(`{ live?: true } | { cycle: name|id } | { cycles: [...], includeLive?: bool } | { all: true }`, default live),
paged (`offset`/`after` + `nextOffset`/`next`), replies within `REPLY_BUDGET` with remaining counts, and a `why`
whenever lines or statements are missing (`LOGS_OFF`, `NO_AGENT`, `BELOW_LEVEL` naming the level that applied to that call - "assumed" when only the current setting is known - `DB_OFF`). A pattern search that hit its time bound says `cutShort` and how far it got.

## New tools

| Tool | Story | Input (beyond scope/mask/paging) | Returns |
|---|---|---|---|
| `problem_calls` | 0 | `all`, `any`, `none` (signal names), `dbFlags`, `project`, `from`, `to`, `minStatus` | counts per signal, then calls with signals + one-line evidence each |
| `search_logs` | 2 | `text` or `pattern`, `minLevel`, `logger`, `exceptionType`, `from`, `to`, `outside` | total + hits (call line + masked line) |
| `log_problems` | 3 | `levels`, `newSince` | grouped problems; `problem_calls_for` via `fingerprint` input on the same tool |
| `call_story` | 4 | `callId`, `cycleId?`, `startAt: 'start'|'firstError'|seq`, `kinds?` | ordered items (statement / supplier / log) with offsets |
| `exception_source` | 5 | `callId`, `lineId` | parsed frames, application frames resolved to project file:line, skipped frames counted |
| `outside_logs` | 7 | `project`, `around` (ISO or callId), `minutesBefore`, `minutesAfter`, `minLevel` | lines grouped by thread |
| `log_context` | 9 | `callId`, `lineId`, `before`, `after` | the story window around the line |
| `endpoint_health` | 10 | `project`, `from`, `to` | per endpoint counts and durations, worst first |
| `problem_timeline` | 11 | `bucketMinutes`, `signals?` | per-bucket counts + first seen per signal |
| `compare_cycles` | 12 | `before`, `after` (cycle names/ids) | problems new / gone / still, signal counts both sides |
| `investigate_call` | 14 | `callId`, `cycleId?` | report: signals, first error + 5 before, exception source, failing supplier calls, most similar success |
| `set_log_capture` | 8 | `project`, `on?`, `level?` (`ERROR`…`APP`) | `changed: [{setting, from, to}]` - no confirmation |

## Extended tools

| Tool | Change |
|---|---|
| `triage` | log errors/warnings/exceptions and DB flags count as evidence (errors raise a 2xx call into group 4; warnings listed, never outrank errors); `scope` input; says when logs were unavailable |
| `call_logs` | `capturedLevel` (done in 009), `why` uses `BELOW_LEVEL` |
| `diff_calls` | `logs` section: only-in-A, only-in-B, first divergence (fingerprint LCS) |
| `trace_value` | also searches the call's log lines (message + exception text), reporting level/logger/seq |
| `wait_for_calls` | `until: 'any' | 'logError' | 'logWarning' | 'dbFailed' | 'problem'`, returns the matching call with its first matching line/statement |
| `set_db_capture` | no `confirm` needed; returns `changed` |
| `list_projects` | shows ▤ and Log level per project |

## Server instructions

Replace the "ask before changing switches" wording with: "You may change capture switches and the Log level when it
helps an investigation; always tell the user what you changed (old → new)." Add a short "investigation order":
`problem_calls` or `triage` → `investigate_call` → `call_story`/`log_context` → `exception_source`/`locate_source`.
