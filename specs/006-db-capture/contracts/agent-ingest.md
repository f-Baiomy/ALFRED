# Contract: agent → backend

All agent endpoints require `X-Webhook-Secret` (the existing `alfred.webhook.secret`); a wrong or missing secret is
`401` with no body. Bodies are plain JSON (the agent does not compress: batches are small and sent on the same host
or LAN, and skipping gzip keeps the agent JDK-only). Served under the `/db-capture` prefix, which is added to the
gateway regex.

## Agent arguments

`-javaagent:alfred-db-agent.jar=<args>` or Attach API `loadAgent(jar, <args>)`:

```
alfredUrl=http://localhost:3000;project=wallet-app;secretFile=C:/projects/Alfred/Alfred/.env
```

`secretFile` points at a file containing `WEBHOOK_SECRET=...` (read once; the secret is never logged or put on a
command line). `secret=` is accepted for `-javaagent` use where a file is impractical.

## `POST /db-capture/agent/heartbeat`

Every 10 s, and once at start.

Request:
```json
{
  "agentId": "b1f…", "agentVersion": "1.0.0", "project": "wallet-app",
  "jvm": "OpenJDK 1.8.0_402", "appServer": "WildFly 26.1.3",
  "droppedSinceStart": 0, "queuedStatements": 12
}
```

Response `200` - the project's capture config (data-model `DbCaptureSettings`, minus thresholds which only the backend
uses):
```json
{
  "rowsPerResult": 50000,
  "beforeImageTables": ["payment_holds", "loyalty_pending"],
  "outsideCallCapture": true,
  "captureEnabled": true,
  "ignorePatterns": ["SELECT 1", "QRTZ_%"]
}
```
`captureEnabled` is the project's switch (the flag file). Inside calls the agent follows `db=` in `X-Alfred-Call`;
outside calls it captures only when `captureEnabled` AND `outsideCallCapture` are both true.

## `POST /db-capture/agent/batch`

Request (≤ 2,000 statements, ≤ 32 MB):
```json
{
  "agentId": "b1f…", "project": "wallet-app", "droppedSinceLastBatch": 0,
  "statements": [
    {
      "callId": "7c1e09a2-…", "runTag": null, "thread": "default task-14", "seq": 17,
      "kind": "SELECT", "sql": "SELECT balance, currency, version FROM wallet WHERE user_id = ? FOR UPDATE",
      "fingerprint": "9f2c…", "table": "wallet",
      "params": [[{"type": "BIGINT", "value": "1042"}]],
      "outcome": {"kind": "ROWS", "columns": [{"name": "balance", "type": "DECIMAL"}, {"name": "currency", "type": "VARCHAR"}, {"name": "version", "type": "INTEGER"}],
                  "rows": [[{"type": "DECIMAL", "value": "500.00"}, {"type": "VARCHAR", "value": "AED"}, {"type": "INTEGER", "value": "41"}]],
                  "rowsRead": 1, "partial": false, "overLimit": false},
      "startedAt": "2026-10-04T18:02:43.205Z", "durationMicros": 6200,
      "txId": "tx-7", "connectionId": "pool-3", "codeLocation": "WalletRepository.lockByUser(WalletRepository.java:88)",
      "dataSource": "Oracle Database 19c 19.3.0.0.0",
      "beforeImage": null, "cascadesTo": []
    },
    {
      "callId": "7c1e09a2-…", "seq": 22, "kind": "COMMIT", "sql": "COMMIT",
      "outcome": {"kind": "TX_END", "result": "COMMITTED", "heldMicros": 348000},
      "txId": "tx-7", "connectionId": "pool-3", "params": [], "startedAt": "…", "durationMicros": 2600, "thread": "default task-14",
      "fingerprint": "…", "dataSource": "…"
    }
  ]
}
```

`outcome.kind` ∈ `ROWS | UPDATED | PROCEDURE | FAILED | TX_END` - fields per data-model `StatementOutcome`.

A statement Hibernate made also carries `origin` (absent for plain JDBC) - see docs/db-capture.md:

```json
"origin": {
  "id": "agent-1:q17", "kind": "HQL", "text": "from UserGroup g where g.branch.id = :branchId",
  "name": "UserGroup.byBranch", "method": "list", "params": [{"name": ":branchId", "value": "948"}],
  "firstResult": 100, "maxResults": 50
}
```

`kind` ∈ `HQL | NATIVE | CRITERIA | LAZY_LOAD | LOAD | FLUSH | HIBERNATE`. Events carry `entity`, `entityId`, `role`,
`action` (FLUSH: `INSERT | UPDATE | DELETE | COLLECTION`), `changed` (a flushed UPDATE's properties) and `parentId`
(the query they ran inside). Statements of one query execution share `id`.

The batch also carries call markers (data-model `CallMarker`):

```json
"markers": [
  { "callId": "7c1e09a2-…", "seq": 0,  "type": "CALL_OPEN", "at": "2026-10-04T18:02:43.118Z" },
  { "callId": "7c1e09a2-…", "seq": 18, "type": "HTTP_OUT",  "at": "2026-10-04T18:02:43.214Z",
    "method": "POST", "url": "https://pay.supplier.com/v1/charge" }
]
```

`CALL_OPEN` is enqueued when the servlet advice opens a context with `db=1`; `HTTP_OUT` when the outbound advice
adds `X-Alfred-Parent` (same `seq`). URLs are sent without query strings.
A long result may be split across batches: a statement with `"rowsContinued": true` and `"rowsFrom": 500` appends rows.

Response `202` `{ "accepted": 2, "duplicates": 0 }`. `400` with field errors (Bean Validation) on malformed input.
Ingest is idempotent on `(callId, seq)`.

## Agent behaviour guarantees (tested in `db-agent`)

- The application thread only enqueues; it never performs I/O for capture (FR-005).
- Queue full ⇒ drop + count; counts reported in the next batch.
- Backend down ⇒ one retry with back-off, then drop; at most one WARN per minute; statement data never logged.
- `StatementInterceptor.before()` is the single seam a later Relive version extends (FR-042); now it always returns
  `Proceed`.
