# Quickstart: verifying log-aware investigation

Prerequisites: Alfred running (`docker compose up -d --build backend frontend`, then `docker compose restart
app-gateway`), the db-agent attached to the project with ▤ on (Log level WARN or lower for the warning checks), the
MCP server registered in Claude Code (docs/mcp.md).

## 1. Problem calls (Story 0)

1. Record a cycle with: one 5xx, one 200 whose service catches an exception and logs ERROR, one call with an N+1, one
   with WARN lines only, one clean call.
2. Ask Claude: "Which calls in cycle X have problems?" → it calls `problem_calls { scope: { cycle: "X" } }`.
3. Check: counts per signal equal the cycle page's pills (DB failures, Log errors, Log warnings); the 200-with-ERROR
   call is listed as severity error with `LOG_ERROR`; the clean call is absent.
4. "Only DB warnings" → `problem_calls { all: ["DB_WARNING"], none: ["LOG_ERROR","HTTP_ERROR","DB_FAILED"] }` returns
   the N+1 call with `REPEATED_QUERY`.
5. `scope: { all: true }` lists a call held both live and in the cycle once, `heldIn: ["live","cycle:X"]`.

## 2. Triage with log evidence (Story 1)

`triage` on the cycle: the 200-with-ERROR call sits in group 4 with its error line (logger, message, exception type)
as evidence.

## 3. Search and grouping (Stories 2, 3)

- `search_logs { text: "No enum constant" }` → every call that logged it, with offsets; `total` exact.
- `log_problems` → the repeated error is one problem with its call count; `log_problems { fingerprint }` lists its calls.

## 4. One call (Stories 4, 5, 9, 14)

- `investigate_call { callId }` → signals, first error with the 5 items before it, exception source resolved to a
  project file, failing supplier calls, a similar successful call.
- `call_story { startAt: "firstError" }` and `log_context { lineId, before: 3, after: 2 }` show the same order as the
  database window's Together view.

## 5. Settings (Story 8)

`set_log_capture { project: "odeysys", level: "DEBUG" }` → the popup's ▤ Log lines shows DEBUG within a second; the
reply lists `changed: [{ setting: "logLevel", from: "WARN", to: "DEBUG" }]`; the agent picks it up within 10 s.

## 6. Scale check

With ≥ 20,000 calls and ≥ 1 M lines stored: `problem_calls { all: true }`, `search_logs { text: "Exception" }` and
`log_problems` each answer in under 1 s (backend timing in the response's `tookMs`).

## Automated

```bash
cd backend && mvn -pl backend-app -am test
cd mcp-server && npm test
```
