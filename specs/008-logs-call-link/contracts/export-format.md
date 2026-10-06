# Contract: log lines in exports

- **In memory**: `CallRecord.logLines?: LinkedLogLine[]` (attached by the export dialog and per-call downloads,
  like `dbCapture`), redacted by `redact.ts` exactly like bodies (FR-017a).
- **.json v3** (`json-export-v2.ts`, format stays `alfred-calls/3`, additive): a `logLines` section after
  `dbStatements` and before `dbRows` - one record per line `{ "of": <call line>, …LinkedLogLine }`; the call's index
  line gets `logs: { lines, errors, warnings, matchedBy }`; `guide`/`layout` describe the section. Never cut.
  `import-parser.ts` reads it back onto the call; v1/v2 files have none.
- **.md**: per call, after the Database section, a "📜 Logs (N lines, matched by …)" `<details>` with a table
  `| +ms | Level | Thread | Message |` (message whole, `mdCell`-escaped), each line's raw JSON in a nested
  `<details>`.
- **.html**: per call, a closed "📜 Logs" block like the Database block, one closed row per line (offset, level,
  message) opening to the raw line; escaped with the builder's `escapeHtml`. The database window's "Together"
  ordering is not repeated in exports (time offsets make it readable).
- **About This Document** (`export-narrative.ts`) adds one sentence when any call carries log lines.
