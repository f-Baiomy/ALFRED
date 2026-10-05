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

Every stored row is written - nothing is cut (architectural invariant). That is the version-1 shape
(`bulk-json-builder.ts`, still read on import). **Exports now write version 2** (`json-export-v2.ts`, see
docs/frontend-architecture.md): one line per inbound call in `dbCalls` (summary, transactions, supplier markers,
the values all its statements share in `common`, HQL origins by id in `origins`) and one line per statement in
`dbStatements` (`of` = its call), rows as values under their columns' types (`rowValues`/`beforeValues`; a cell
that is an object is a full TypedValue, `{}` a null cell). `import-parser.ts` rebuilds exactly the version-1
capture from either, and the import stores it through the slice's ingest port.

`.md` / `.html`: after a call's response section, a "Database" section - statements in run order (values filled in,
kind, result, duration), transactions as headed groups, result rows and before-images as tables, opened by the
database window's summary line and its findings (`analysis.summary`/`analysis.findings`, db-findings.ts - the flags
list when a call has no analysis). The .json `dbCalls` line carries the same `analysis`, and its index line each
call's `findings` (severity, title, impactMs, first 20 seqs). Call data escaped as today. `export-narrative.ts` adds one sentence when statements are present.

Redaction: `shared/utils/redact.ts` stays the single choke point. A new `RedactionKind` `db-column` masks, in
every format, the values of result/before-image columns with that name and the parameters bound to that column
(INSERT column list, `SET col = ?`, `WHERE col = ?` - mapped by `sql-param-columns.ts`), and counts them in
`redactedValueCount`. The live window is never masked (existing redaction semantics).

Discord, cURL, Postman: unchanged.
