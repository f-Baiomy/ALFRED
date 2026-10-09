# Contract: proxy -> backend call reports

Applies to the reverse proxy (`proxy/log_and_route_reverse.py` -> `/internal-calls/webhook/*`) and the forward proxy
(`proxy/log_and_route.py` -> `/calls/webhook/*`). Endpoints, paths and the `X-Webhook-Secret` header are unchanged.

## Delivery policy (FR-001 - FR-003)

| | value |
|---|---|
| per-attempt timeout | `WEBHOOK_TIMEOUT_SECONDS` / `PREPARE_TIMEOUT_SECONDS`, default **15** (was 2) |
| retries | up to **3** after a retryable failure, waiting **2 s, 5 s, 10 s** |
| retryable | timeout, connection refused/reset/closed, HTTP 5xx |
| not retried | HTTP 4xx (401 secret, 404 unknown call, 400 payload) |
| order | one worker thread, FIFO: a call's prepare is delivered or given up before its complete is attempted |
| request path | never waits on a retry; the only synchronous send (a Relive step's prepare) is tried once, then handed to the worker queue for its retries |
| backend cannot store | answers 5xx (logged ERROR with the call id), so the report is retried; never 2xx for a dropped call |
| identity bounds | `call.url`/`call.original_url` <= 8 KB, `call.method` <= 16 chars; larger -> 400 (not retried) |

Log lines (stdout, flushed immediately; never bodies, headers or the secret):

```text
[webhook] prepare attempt 1/4 failed for <call id>: timed out
[webhook] complete attempt 2/4 failed for <call id>: HTTP 503 Service Unavailable
[webhook] prepare given up for <call id> after 4 attempts
[webhook] complete failed for <call id>: HTTP 404 Not Found (not retried)
```

## Backend idempotency (required by retries)

- `POST .../webhook/prepare` repeated for the same `id`: the request side is written again; the outcome, if already
  stored, is kept. Answer unchanged (200 with the id).
- `POST .../webhook/{id}/complete` repeated: the outcome is written again on the same row - never a second row.
  `204` when the call was prepared, `404` when it was not (the call is stored from the completion either way; the
  proxy does not retry a 404).
- Either order of prepare and complete yields the same stored call.

## Complete payload (inbound) - shipped in 326ac85b

```json
{
  "response": {"status": 200, "headers": {"...": "..."}, "body": "..."},
  "duration_ms": 29.87,
  "interception": null,
  "reached_upstream": true,
  "call": {
    "original_url": "http://localhost:9001/odeysysadmin/Admin2/userDetails",
    "url": "http://host.docker.internal:9001/odeysysadmin/Admin2/userDetails",
    "method": "OPTIONS",
    "timestamp": "2026-10-06T21:49:47.244+00:00",
    "service_name": "odeysys",
    "session_id": null,
    "operation_id": null
  }
}
```

`call` is optional (absent from an older proxy). It never carries request headers or body.
