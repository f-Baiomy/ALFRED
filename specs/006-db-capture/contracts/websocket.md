# Contract: `/ws/db-capture`

Opened with `reconnectingSocket` (re-fetch on reconnect), the same as `/ws/calls` and `/ws/internal-calls`. The
backend broadcasts; clients fetch on demand. No polling anywhere.

```json
{ "type": "statements-appended", "callId": "7c1e09a2-…", "lastSeq": 31, "summaryChanged": true }
{ "type": "outside-appended", "thread": "EJB timer-3", "count": 4 }
{ "type": "capture-settings-changed", "project": "wallet-app" }
{ "type": "agent-status-changed", "project": "wallet-app", "attached": true }
```

Consumers:
- ◆ DB chip of a visible card: on `statements-appended` for its call with `summaryChanged`, re-fetch its summary
  (debounced per animation frame across cards into one `summaries` request).
- Open database window: fetch `statements?afterSeq=<its last seq>`.
- Sources bar, cycle widget, Settings: on `capture-settings-changed` / `agent-status-changed`, re-fetch
  `GET /db-capture/projects` (SC-009).
