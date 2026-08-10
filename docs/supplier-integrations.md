# Supplier integrations (proxy layer)

Alfred intercepts HTTPS calls a Java app makes to any hostname ending in `-proxy`, with zero config changes in the Java app: a hosts-file redirect + a trusted CA cert make the app believe it's talking directly to the real supplier.

- **`suppliers.txt`** lists real domains, no `-proxy` suffix (scripts add it). **`jdks.txt`** lists extra `JAVA_HOME` paths needing cert trust, beyond whatever `JAVA_HOME` is currently set in the environment (that one is auto-included, deduplicated by exact path). Both support `#` comments, re-read/re-applied idempotently on every `start.py` run.

- **Routing happens in two places in `proxy/log_and_route.py`, deliberately**: `server_connect` sets the actual TCP/TLS dial target from the client's TLS SNI (captured before the HTTP request is parsed); `request()` rewrites `flow.request.host`/`Host` for logging only. In reverse mode, mutating `flow.request.host` alone does **not** change where mitmproxy connects — both hooks are required.

- **SNI, not the `Host` header, is the source of truth for the original hostname**, because `flow.request.host` starts out pinned to a static placeholder (`https://placeholder.invalid`, set in `docker-compose.yml`'s `mitmdump` command) in reverse mode.

- **The proxy persists nothing.** `response()`/`error()` run synchronously on mitmproxy's asyncio loop, so `_write()` is a non-blocking `queue.put_nowait()`; a single daemon thread drains the queue and POSTs to `WEBHOOK_URL` via stdlib `urllib.request`, swallowing (and logging) failures rather than raising. Stdlib-only deliberately — `proxy` runs the stock `mitmproxy/mitmproxy` image, no Dockerfile/pip step. **`WEBHOOK_URL` is load-bearing**: if unset or the webhook is failing, the call is proxied correctly but never recorded anywhere (backend is the sole writer of call history).

- Webhook payload always includes both `original_url` (the `-proxy` URL called) and `url` (the real forwarded URL), plus method/headers/body/timestamp/duration_ms/response — identical shape to the `CallRecord` domain type.

- **Per-folder CA identity**: `proxy/certs/` holds a CA generated fresh on first container start, unique to that project checkout. Only one Alfred folder's CA can be trusted under the "mitmproxy" friendly name per OS/JDK truststore at a time — running `start.py` from a different folder re-syncs trust to that folder's CA.

- **A running JVM does not pick up truststore changes live** — restart the Java app after its JDK's cert import.

## Host-side setup (Docker cannot touch hosts file / OS cert store)

- `setup.bat`/`setup.sh` are a **one-time, separate** step installing Docker/Python (`winget`/apt-dnf-yum/Homebrew) — they don't touch hosts/certs/containers.
- `start.py` (delegates to `start.ps1` via `certutil` or `start.sh` via `update-ca-certificates`/Keychain) does, in order: add missing `*-proxy` hosts entries → `docker compose up -d --build` → resync CA into OS store → resync CA into every JDK in `jdks.txt` + current `JAVA_HOME`. Safe to re-run; already-done steps are skipped.
- `ensure_backend_port()` (in `start.py`/`restart.py`) probes port 5000 with a plain socket **without `SO_REUSEADDR`** — on Windows that flag would let the probe bind over an already-listening socket and falsely report "free". Skips the check if `.env` already exists or this project's own backend container is already up (avoids mistaking our own binding for a conflict). Otherwise walks upward in steps of 50 until free and writes `.env`.
- `deploy.py [service...]` = `git checkout master && git pull` then delegates to `restart.py` — does not touch hosts/certs, and only warns (non-blocking) on a dirty working tree rather than stashing on the deployer's behalf.
- `frontend/.dockerignore` / `backend/.dockerignore` exist specifically to stop `node_modules`/module `target/` dirs from bloating the Docker build context on every rebuild — check these first if a build reports a suspiciously large context.
