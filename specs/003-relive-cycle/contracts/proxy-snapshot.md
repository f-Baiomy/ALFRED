# Proxy contract: run snapshots

Written by `backend-relive` into the shared `proxy/interception/relive/` directory, atomically (temp file + rename),
exactly like `rules.json`. Read by both addons (`log_and_route.py`, `log_and_route_reverse.py`) through a cached
loader in `interception.py`; the directory mtime is checked at most once per second.

## `relive/<runId>.json`

```json
{
  "version": 1,
  "state": "RUNNING",
  "runId": "b2c…",
  "cycleId": "91a…",
  "driver": "AUTOMATIC",
  "globalRules": { "mode": "SELECTED", "selectedIds": ["r-currency"] },
  "projects": ["odeysys", "core-service"],
  "variables": { "searchId": "xyz", "token": "•secret•" },
  "secrets": ["token"],
  "steps": [
    {
      "stepKey": "s-search",
      "direction": "inbound",
      "serviceName": "odeysys",
      "children": [
        {
          "stepKey": "c-supA",
          "mode": "REPLAY",
          "unattributed": "BLOCK",
          "ordinal": 1,
          "match": { "source": "outbound", "methods": ["POST"], "host": "api.supplier-a.com", "pathRegex": "^/v2/search$" },
          "answerId": "8f0c…-uuid",
          "pause": { "before": false, "after": true, "timeoutMs": 30000 },
          "onRequestChanged": "REPLAY",
          "recordedRequest": { "method": "POST", "path": "/v2/search", "query": "", "bodyRef": "8f0c…-uuid.req" },
          "ignore": ["body.requestTime"],
          "rules": [ { "id": "sr-1", "name": "Supplier A slow", "match": {}, "actions": [ { "type": "DELAY_REQUEST", "durationMs": 2000 } ] } ]
        },
        { "stepKey": "c-supB", "mode": "LIVE", "ordinal": 1,
          "match": { "source": "outbound", "methods": ["POST"], "host": "api.supplier-b.com", "pathContains": "/search" } }
      ]
    }
  ],
  "cycleRules": [ { "id": "cr-1", "name": "X-Debug", "priority": 10, "match": {}, "actions": [] } ],
  "unexpectedCalls": { "policy": "RULES", "fallback": "BLOCK",
    "rules": [ { "id": "ur-1", "name": "Loyalty stub", "match": { "host": "api.loyalty.io" }, "actions": [ { "type": "MOCK_RESPONSE" } ] } ] }
}
```

> **Superseded by research D17:** each child now carries a single `callRule` (the rule document) instead of
> `answerId` / `pause` / `onRequestChanged` / `rules`. REPLAY is its `MOCK_RESPONSE`, LIVE with a mocked reply is
> its `REPLACE_RESPONSE`, pauses are `PAUSE_*` actions, and "request differs" is an `IF_REQUEST` with the new
> `MATCHES_RECORDED_CALL` condition. `recordedRequest`/`ignore` stay, as that condition's input.
>
> **Recorded request file (FR-014d):** for every child whose `callRule` contains a `MATCHES_RECORDED_CALL`
> condition, the backend writes the child's frozen recorded request as a stored answer
> `relive/answers/<runId>/<answerId>.{meta.json,body}` (the `.body` is the request body; `meta.json` holds method,
> path, query and headers) and puts that `answerId` into the condition. In the cycle definition the condition
> refers to the recording by `recordedStepKey`; `RunSnapshotBuilder` replaces it with the `answerId`. If the file is
> missing or unreadable, the condition evaluates to **"differs"**, so the request-differs branch (default: failure
> mock) runs. It never counts as a match.

- `match` / rule documents use the existing interception rule shape (`Match`, `Rule`); `{{name}}` is rendered with
  `variables` before evaluation, as `_resolve_variable_tokens` does for `rules.json`.
- `answerId` points at a stored answer the backend writes under `relive/answers/<runId>/<answerId>.{meta.json,body}`,
  same format as `answers/`; the UUID guard (`ANSWER_ID`) applies.
- Step `rules` and `cycleRules` are ordinary rule documents run through the **same** evaluator as `rules.json`
  (`interception.py`'s match + action pipeline), so every action the addons support works in a run, including
  actions added later; the addon has no Relive-specific action code. A step rule applies only to the request
  matched to that step.
- **Request changed** (FR-014d): for a matched REPLAY child the addon compares the live request with
  `recordedRequest` (method, path, query, canonical JSON/text body with `ignore` paths and the cycle's noise
  removed) before answering. If equal, it answers as usual. If different, `REPLAY` answers anyway and `SEND_REAL`
  forwards upstream, each logging `REQUEST_CHANGED` with the differing paths. `ASK` holds the flow through
  `breakpoints.py` (default action: the failure mock after `timeoutMs`, never forward), with the paused entry carrying
  `relive: { runId, stepKey, at: "CHANGED", changes[] }`. Both sides are canonicalized in Python, so the
  backend never has to reproduce the comparison.
- **Unexpected calls** (FR-014f): a request attributed to the run that matches no child: `BLOCK` answers `502`
  `{"error":"Blocked by ALFRED Relive","runId":…}` without contacting upstream; `SEND_REAL` forwards; `RULES`
  evaluates `unexpectedCalls.rules` with the same evaluator (first match wins, `stopProcessing` implied), then
  `fallback`. Cycle rules and participating global rules still apply after, as in D4.
- `secrets` lists variable names whose values must be masked in anything the proxy logs.
- `state` is `RUNNING` or `STOPPING` (FR-033). While `STOPPING`, the addon ignores every call rule, unexpected-call
  policy and unattributed choice of the run: every call attributed to the run, and every unattributed call that
  would match one of its REPLAY children, is answered `502 {"error":"Blocked by ALFRED Relive - run stopping","runId":…}`
  without contacting upstream. The backend removes the file once the run's in-flight calls are done or 30 s pass.

`pause` (optional) makes the addon hold the flow through `breakpoints.py`, before forwarding or answering and/or
before the response reaches the application, for up to `timeoutMs`, with default action "continue with `mode`".
The paused registration carries `relive: { runId, stepKey, at }`.

## `relive/inflight.json`

```json
{ "at": 1790000000000,
  "projects": { "odeysys": [ { "callId": "…", "runId": "b2c…", "stepKey": "s-search" }, { "callId": "…", "runId": null } ] } }
```

Present only while at least one run is active. An outbound request from project P is attributed by in-flight
uniqueness only when `projects[P]` has exactly one entry and it has a `runId` (research D2.3). When entries from
more than one run are in flight for P, or the request would match children of more than one active run, the call
is `AMBIGUOUS` (FR-050a): blocked with `502`, never forwarded, and logged in every run concerned.

## Evaluation order (research D4)

For a request attributed to run R: R step rules (matched child's answer / match rule) → R cycle rules → participating
global rules. Unattributed traffic: global rules only. `stopProcessing` and priority semantics unchanged within a tier.

## Headers

| Header | Set by | Trusted when | Stripped before upstream/log |
|---|---|---|---|
| `X-Alfred-Relive: <runId>/<stepKey>` | backend-resend (inbound step) | peer is the backend (`take_resend_headers` rule) | yes |
| `X-Operation-Id: relive-<runId>-<stepKey>` | backend-resend (inbound step) | always (only used for attribution) | no - it's the application's to propagate |
