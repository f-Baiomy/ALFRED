# Contract: Proxy to backend webhook changes

Both addons keep their single ordered worker queue (`log_and_route.py:105-136`,
`log_and_route_reverse.py:77-101`). Every change is additive, so an older backend ignores the
unknown fields.

## Prepare (`POST {WEBHOOK_URL}/prepare`)

Added fields, present only for a resent call:

```json
{ "resend_of": "<original call id>",
  "resend_edits": { "origin": { "direction": "outbound", "cycleId": null },
                    "headers": ["x-test"], "body": true,
                    "batch": { "id": "b-1", "index": 2, "total": 5 } } }
```

`resend_edits` keys: `origin: {direction, cycleId|null}` (always present, so the header is always
sent), `method?: {from, to}`, `url?: {from, to}`, `headers?: [names]`, `body?: true`,
`session?: [{name, fromCallId}]`, `batch?: {id, index, total}` (only when the resend was part of a
batch).

- The addon reads `X-Alfred-Resend-Of` and `X-Alfred-Resend-Edits` (JSON, ≤ 8 KB) from the
  request.
- It **deletes both headers from `flow.request` before forwarding**. Rule matching runs after
  the deletion, so a rule cannot see or match on these headers.
- The addon honours them only when the connection comes from the backend container. The check
  compares the peer address (`client_conn.peername`) with `BACKEND_HOST`, resolved once at load
  time. From any other client, both headers are stripped and ignored. A normal client can
  therefore neither forge resend links nor leak them to suppliers.

## Complete (`POST {WEBHOOK_URL}/{id}/complete`)

- The reverse addon already sends `interception`. The backend now **stores** it
  (`CompleteInternalCallRequestDto.interception`).

## WebSocket messages (new)

`POST {WEBHOOK_URL}/{callId}/ws-messages` (with header `X-Webhook-Secret`)

```json
{ "messages": [
    { "seq": 17, "direction": "server", "tsMillis": 1790000000123, "type": "text",
      "content": "…", "originalContent": "…", "action": "edited",
      "ruleId": "…", "ruleName": "…" } ],
  "closed": false, "closeCode": null }
```

- A batch is sent every 500 ms or every 50 messages per connection, whichever comes first.
  `websocket_end` sends a final batch with `closed: true` and `closeCode`.
- The addon keeps per-connection `seq` counters in `flow.metadata`.
- Content is the full message (constitution: no truncation). The per-connection cap is enforced
  by the backend.
- The response is `204`, or `404` when the call id is unknown. The addon logs the 404 and drops
  the batch; it never retries.
