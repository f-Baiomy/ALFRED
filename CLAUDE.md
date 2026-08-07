# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Alfred is a reverse-mode mitmproxy setup that transparently intercepts and logs every HTTPS request/response a Java app sends to any supplier whose configured hostname ends in `-proxy`. It requires zero configuration changes in the Java app itself — no proxy settings, no code changes. Instead, a hosts-file redirect plus a trusted CA cert make the app think it's talking directly to the real supplier.

Three Docker services (see `docker-compose.yml`):
- **alfred** (mitmproxy, port 8444->8080) — intercepts, dynamically routes `*-proxy` hostnames to their real backend by stripping the suffix, and logs full request/response data as JSON lines to `proxy/logs/calls.log`.
- **pennyworth** (Spring Boot backend, port 5000) — reads `calls.log` and serves it over a small HTTP API (`GET /calls`, `GET /health`). Intentionally minimal; scope expands as needed.
- **manor** (static HTML dashboard via nginx, port 3000) — polls pennyworth every 5s and displays recent calls. Current version is a placeholder page meant to be replaced.

## Commands

Cross-platform entry point (run from an Administrator/root terminal):

```bash
python3 start.py
```

This does all of the following, safe to re-run any time (already-done steps are skipped):
1. Adds missing `*-proxy` hosts entries from `suppliers.txt`
2. Runs `docker compose up -d --build` (generates the CA cert on first run)
3. Re-syncs the CA cert into the OS certificate store
4. Re-syncs the CA cert into every JDK listed in `jdks.txt`

It detects the OS and delegates to `start.ps1` (Windows, via `certutil`) or `start.sh` (Linux/macOS, via `update-ca-certificates`/Keychain, run with `sudo`).

To (re)start containers without redoing the hosts/cert steps:

```bash
docker compose up -d --build
```

Stop everything:

```bash
docker compose down
```

Watch logs live:

```bash
Get-Content .\proxy\logs\calls.log -Wait -Tail 20 | jq .
```

There is no test suite, linter, or build step beyond the Docker builds themselves.

## Architecture notes

- **Routing happens in two places for a reason** (`proxy/log_and_route.py`): `server_connect` sets the actual TCP/TLS dial target using the client's TLS SNI (captured before the HTTP request is parsed), while `request()` rewrites the logical `flow.request.host`/`Host` header for logging consistency. In reverse mode, mutating `flow.request.host` alone does NOT change where mitmproxy actually connects — both hooks are required.
- **SNI, not `Host` header, is the source of truth** for the original hostname throughout the addon, since in reverse mode `flow.request.host` starts out pinned to the static placeholder (`https://placeholder.invalid`, set in the `mitmdump` command in `docker-compose.yml`).
- **Suppliers and JDKs are config, not code**: `suppliers.txt` lists real domains (no `-proxy` suffix — scripts add it), `jdks.txt` lists `JAVA_HOME` paths needing cert trust. Both support `#` comments and are re-read/re-applied idempotently on every `start.py` run.
- **Per-folder CA identity**: `proxy/certs/` holds a CA generated fresh on first container start, unique to that project folder. Only one Alfred folder's CA can be trusted under the "mitmproxy" friendly name at a time per OS/JDK truststore — running `start.py` from a different Alfred folder re-syncs trust to that folder's CA.
- **Docker cannot touch the host** (hosts file, OS cert store): this is why `start.py`/`start.sh`/`start.ps1` exist as host-side wrappers run outside any container, before/alongside `docker compose`.
- **JVM truststore caching**: a running JVM does not pick up truststore changes live — restart the Java app/server after its JDK's cert import.
- Log format written by the proxy (see README for the full example) always includes both `original_url` (the `-proxy` URL the app called) and `url` (the real forwarded URL), plus method, headers, body, timestamp, duration_ms, and response.
