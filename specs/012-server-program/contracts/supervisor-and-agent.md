# Contract: supervisor control API and agent arguments

## Supervisor control API (research R6)

Listens on `127.0.0.1:<random>`. On each start it writes `data/run/control.json`
`{"port": n, "token": "<32 random bytes, hex>", "pid": n}`, readable only by the service account. Every
request needs `X-Alfred-Control-Token: <token>`; without it the answer is `401`.

| Method | Path | Response |
|---|---|---|
| GET | `/status` | `{processes: [{name: BACKEND\|OUTBOUND\|REVERSE\|MCP\|LOG_AGENT, state, pid, startedAt, restarts, listeners}]}` |
| POST | `/restart/backend` | `202`; graceful stop (20 s), start with current `.env` |
| POST | `/restart/proxies` | `202`; restarts OUTBOUND and REVERSE with arguments rebuilt from `.env` |
| POST | `/reload` | `200 {restarted: [...]}`; re-reads `.env`, restarts only the processes whose inputs changed |
| GET | `/update` | `{state: IDLE\|DOWNLOADING\|VERIFYING\|INSTALLING\|FAILED, version, downloadedBytes, totalBytes, error}` |
| POST | `/update` | body `{version, url, sha256, size}`; `202` and the job runs: download to `data/updates/`, sha256 check, installer launched detached (Windows `/S /DIR=`, breakaway from the job object; Linux `systemd-run --unit alfred-update-<ts> ... --unattended --dir`). `400` without a checksum or with a non-http(s)/file URL, `409` while one runs. Progress is posted as a supervisor event named `UPDATE`. |

When a child changes state, the supervisor posts `POST {backend}/server/supervisor-events` with
`X-Webhook-Secret`; the body is that child's `/status` entry (`name`, `state`, `pid`, `startedAt`, `restarts`,
`listeners`, `detail`) plus `at`.

A crashed child is restarted with back-off of 1 s, 2 s, 5 s, 10 s, then 30 s. After 5 crashes in 5
minutes it stays `CRASHED` and reports that; it does not loop forever.

## Proxy command lines (built from `.env` by the shared settings module)

```
OUTBOUND: runtime/python/bin/python -c "from mitmproxy.tools.main import mitmdump; mitmdump()" -q -s app/proxy/log_and_route.py
          --mode regular@<ALFRED_OUTBOUND_PROXY_LISTEN> [--mode regular@<outboundHost>:<outboundPort> per project]
          --set confdir=data/certs --set connection_strategy=lazy
REVERSE:  ... -s app/proxy/log_and_route_reverse.py
          --mode reverse:http://127.0.0.1:<upstream>@<listen> per project
          --set confdir=data/certs --set connection_strategy=lazy --set keep_host_header=true
```
User settings are turned into variables and arguments through `app/settings-env-map.json` (data-model). The environment passed to each proxy is the same variables `docker-compose.yml` sets today
(`WEBHOOK_URL`, `TOGGLE_FILE`, `INTERCEPTION_*`, `BACKEND_HOST`, ...), with native values (research
R14).

## Agent arguments (`alfred-agent.jar`, research R12)

Extends today's `AgentConfig` format, `key=value` pairs separated by `;`:

```
alfredUrl=http://127.0.0.1:3000;project=wallet-app;secretFile=/opt/alfred/.env;
features=proxy,db,logs,redis;proxy=127.0.0.2:443;caFile=/opt/alfred/data/certs/mitmproxy-ca-cert.pem
```
- `features`: the full desired set. Attaching again with a different set switches features on and off
  without re-instrumenting.
- The agent publishes `alfred.agent.features=<set>` and `alfred.agent.version=<v>` as system properties,
  so `alfred jvms` can read the state with `VirtualMachine.getSystemProperties()`.
- `secretFile` keeps working as today: the secret never appears on a command line.
