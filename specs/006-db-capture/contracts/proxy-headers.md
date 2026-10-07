# Contract: proxy headers and flag file

## `X-Alfred-Call` - reverse proxy → application (inbound requests)

Added by `proxy/log_and_route_reverse.py` to every request it forwards for a project whose **inbound logging is
on** (exactly when a `call_id` is created today). Never added when logging is off.

```
X-Alfred-Call: id=<callId>; db=<0|1>[; log=1][; redis=1][; run=<runId>/<stepKey>][; alfred=<url>; key=<issued>.<hmac>]
```

| Part | Meaning |
|---|---|
| `id` | the inbound call id the proxy just assigned (same value it POSTs to `/internal-calls/webhook/prepare`) |
| `db` | `1` when `db-capture-enabled.flag` says `<project>=on`, else `0`. The agent captures only when `1` |
| `run` | present when the request is a Relive step (`flow.metadata['relive']`); stored by the agent on statements (FR-043), unused now |
| `alfred` | where this Alfred is, as the application's host reaches it (`ALFRED_AGENT_URL`: the supervisor sets the UI address natively, compose the gateway's host port). The agent reports THERE from the first stamped request on, whatever its own `alfredUrl` said - a `-javaagent` line written for a port nothing listens on, or for an install that is gone, no longer loses every statement and log line |
| `key` | `<issued>.<HMAC-SHA256(WEBHOOK_SECRET, "agent:<issued>")>`, `issued` = the epoch second of the current hour. The agent presents it as `X-Alfred-Agent-Key`; backend accepts it in place of the secret for 24 h from `issued`. The secret itself never reaches the application; absent when the proxy has no secret |

Rules:
- An `X-Alfred-Call` header arriving **from the client** is removed before the proxy adds its own (a client cannot
  impersonate a call).
- Values are ASCII; parts separated by `; `; unknown parts are ignored by the agent (forward compatible).

## `X-Alfred-Parent` - application (agent) → forward proxy (outbound requests)

Added by the agent to every outbound HTTP request made inside a captured call context.

```
X-Alfred-Parent: <callId>; seq=<n>
```

`proxy/log_and_route.py` **pops** it in the `request` hook before interception and forwarding (suppliers never see
it), and adds to the outbound call log:

```json
{ "parent_call_id": "<callId>", "parent_seq": 7 }
```

Both fields are optional on the backend's outbound call record (`backend-calls`) and in `CallRecord` on the
frontend. When present, the call tree uses them instead of time containment (research D4).

## `proxy/db-capture-enabled.flag`

Same format as `reverse-proxy-enabled.flag`: one `name=on|off` line per project. A project with no line is **off**.

| Reader/writer | Path in container | Behaviour |
|---|---|---|
| `reverse-proxy` | `/home/mitmproxy/db-capture-enabled.flag` (`DB_CAPTURE_TOGGLE_FILE`) | read, mtime-cached like `_ToggleState` |
| `backend` | `/appdata/db-capture-enabled.flag` (`DB_CAPTURE_TOGGLE_FILE`) | read on every call, written by `FileDbCaptureToggleAdapter` |

`docker-compose.yml` bind-mounts `./proxy/db-capture-enabled.flag` into both; `start.py` creates the file (empty)
if missing, like the existing flag.
