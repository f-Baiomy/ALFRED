# Contract: Rules snapshot, answer files and rules export file

## 1. Rules snapshot (backend → both proxies), `proxy/interception/rules.json`

See data-model §5. The new top-level keys are `sensitiveHeaders`, `selfTargets` and `limits`.

- A proxy that finds these keys missing (an older backend) falls back to its built-in defaults.
- An older proxy that finds them present ignores them.
- Action entries carry the new `RuleAction` fields from data-model §2. An older proxy skips an
  action type it does not know. With this feature, that skip is recorded as
  `skipped - unknown action <TYPE>` (FR-022), where today it is silent (`_apply_*_action`
  falls through).

## 2. Answer files, `proxy/interception/answers/`

- `<id>.meta.json`: `{id, kind, status, headers, contentType, sizeBytes, recordedAt}`.
- `<id>.body`: the raw bytes.
- Both are written with a temp file and an atomic move, and the snapshot is written **after**
  the answers it references. A proxy therefore never sees a rule whose answer is missing.
- If an answer is missing anyway (manual deletion), the action records
  `skipped - stored answer <id> not found`. The call proceeds to the host.

## 3. Rules export file (version 2)

```json
{ "alfredInterceptionRules": 2, "exportedAt": "…",
  "rules": [ { "name": "…", "match": {…},
               "actions": [ { "type": "ANSWER_WITH_FILE", "answerRef": "a1", "status": 200 } ] } ],
  "answers": [ { "ref": "a1", "kind": "FILE", "status": 200, "contentType": "application/json",
                 "headers": {"content-type": "application/json"}, "secretsKept": null,
                 "sourceDirection": null, "recordedAt": null, "bodyBase64": "…" } ] }
```

- On export, `answerId` is replaced by `answerRef`, and it is mapped back to a fresh `answerId`
  on import.
- Secrets appear in `headers` only when `secretsKept` is true (FR-026).
- `parseRulesFile` accepts version 1 and version 2, and still rejects a calls export. The
  version-mismatch message lists both versions.
- `import-parser.ts` / `bulk-json-builder.ts` (the **calls** export) are a different format and
  are not affected, except for the WebSocket message addition in the calls export (see plan,
  Phase H).
