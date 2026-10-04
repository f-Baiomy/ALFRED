# Contract: proxy headers and flag file

## `X-Alfred-Call` - reverse proxy → application (inbound requests)

Added by `proxy/log_and_route_reverse.py` to every request it forwards for a project whose **inbound logging is
on** (exactly when a `call_id` is created today). Never added when logging is off.

```
X-Alfred-Call: id=<callId>; db=<0|1>[; run=<runId>/<stepKey>]
```

| Part | Meaning |
|---|---|
| `id` | the inbound call id the proxy just assigned (same value it POSTs to `/internal-calls/webhook/prepare`) |
| `db` | `1` when `db-capture-enabled.flag` says `<project>=on`, else `0`. The agent captures only when `1` |
| `run` | present when the request is a Relive step (`flow.metadata['relive']`); stored by the agent on statements (FR-043), unused now |

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
