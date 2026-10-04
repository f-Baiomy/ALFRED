# Contract: exports

`.json` (bulk export = re-import format, `bulk-json-builder.ts` ↔ `import-parser.ts`): an inbound call event that has
captured statements gains

```json
"dbCapture": {
  "summary": { "statementCount": 49, "writeCount": 13, "failedCount": 1, "flags": [ … ] },
  "transactions": [ { "txId": "tx-7", "outcome": "COMMITTED", "firstSeq": 16, "lastSeq": 27, "heldMicros": 348000 } ],
  "statements": [ { …CapturedStatement, "rows": [[…], …], "beforeImageRows": [[…]] } ]
}
```

Every stored row is written - nothing is cut (architectural invariant). A resolved internal call is still two
events sharing a `callId`; `dbCapture` sits on the **complete** event only, so `groupBy(callId)` + merge stays
correct. `import-parser.ts` restores it and the import stores it through the slice's ingest port. Fixtures are
built with `buildBulkExportPayload`.

`.md` / `.html`: after a call's response section, a "Database" section - statements in run order (values filled in,
kind, result, duration), transactions as headed groups, result rows and before-images as tables, flags listed at
the top. Call data escaped as today. `export-narrative.ts` adds one sentence when statements are present.

Redaction: `shared/utils/redact.ts` stays the single choke point. A new `RedactionKind` `db-column` masks, in
every format, the values of result/before-image columns with that name and the parameters bound to that column
(INSERT column list, `SET col = ?`, `WHERE col = ?` - mapped by `sql-param-columns.ts`), and counts them in
`redactedValueCount`. The live window is never masked (existing redaction semantics).

Discord, cURL, Postman: unchanged.
