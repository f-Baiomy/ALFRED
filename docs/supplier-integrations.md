# Supplier integrations (proxy layer)

Alfred's `proxy` service runs mitmproxy in **regular (forward) proxy mode**: any HTTP/HTTPS-aware client that's been made proxy-aware (e.g. `http.proxyHost`/`http.proxyPort`/`https.proxyHost`/`https.proxyPort` JVM system properties, whether set at JVM startup or injected into an already-running JVM via the Attach API) gets every call it makes logged, for whatever real hostname it actually calls. No hosts-file redirect, no special hostname convention, no code/config change in the client beyond pointing it at the proxy.

- **`log_and_route.py`'s `request()` hook does no rewriting.** In regular mode, `flow.request.host`/`pretty_url` already reflect the real destination the client asked for - via an HTTP `CONNECT` for HTTPS, or an absolute-URI request line for plain HTTP - so the hook just reads them directly into `call_log`. (An earlier reverse-mode version of this addon had to read the client's TLS SNI and rewrite a `-proxy`-suffixed placeholder hostname back to the real one; none of that exists anymore.)

- **The proxy persists nothing.** `response()`/`error()` run synchronously on mitmproxy's asyncio loop, so `_write()` is a non-blocking `queue.put_nowait()`; a single daemon thread drains the queue and POSTs to `WEBHOOK_URL` via stdlib `urllib.request`, swallowing (and logging) failures rather than raising. Stdlib-only deliberately — `proxy` runs the stock `mitmproxy/mitmproxy` image, no Dockerfile/pip step. **`WEBHOOK_URL` is load-bearing**: if unset or the webhook is failing, the call is proxied correctly but never recorded anywhere (backend is the sole writer of call history).

- Webhook payload includes `original_url` and `url` (both equal to the same real URL now that there's no separate "-proxy" URL to distinguish them from - kept as two fields for backward compatibility with the existing `CallRecord` shape/frontend), plus method/headers/body/timestamp/duration_ms/response.

- **Per-folder CA identity**: `proxy/certs/` holds a CA generated fresh on first container start, unique to that project checkout. Only one Alfred folder's CA can be trusted under the "mitmproxy" friendly name per OS/JDK truststore at a time — running `start.py` from a different folder re-syncs trust to that folder's CA.

- **A running JVM does not pick up truststore changes live** — restart the Java app after its JDK's cert import, unless you're injecting proxy properties into an already-running JVM specifically to avoid a restart, in which case make sure that JVM's JDK already trusted this CA *before* you started it.

- **`suppliers.txt` and the hosts-file entries `start.py` writes from it are vestigial** now that `proxy` runs in forward mode - nothing reads a `-proxy`-suffixed hostname anymore. They're harmless (unused hosts entries, an unread config file) but no longer do anything; ask before assuming they should be cleaned up, since a deployment might still have reasons to keep them around.

## Host-side setup (Docker cannot touch hosts file / OS cert store)

- `setup.bat`/`setup.sh` are a **one-time, separate** step installing Docker/Python (`winget`/apt-dnf-yum/Homebrew) — they don't touch hosts/certs/containers.
- `start.py` (delegates to `start.ps1` via `certutil` or `start.sh` via `update-ca-certificates`/Keychain) does, in order: add missing `*-proxy` hosts entries (vestigial, see above) → `docker compose up -d --build` → resync CA into OS store → resync CA into every JDK in `jdks.txt` + current `JAVA_HOME`. The CA-trust steps are still load-bearing - a client trusting this CA is what lets it get proxied HTTPS calls without cert errors. Safe to re-run; already-done steps are skipped.
- `ensure_backend_port()` (in `start.py`/`restart.py`) probes port 5000 with a plain socket **without `SO_REUSEADDR`** — on Windows that flag would let the probe bind over an already-listening socket and falsely report "free". Skips the check if `.env` already exists or this project's own backend container is already up (avoids mistaking our own binding for a conflict). Otherwise walks upward in steps of 50 until free and writes `.env`.
- `deploy.py [service...]` = `git checkout master && git pull` then delegates to `restart.py` — does not touch hosts/certs, and only warns (non-blocking) on a dirty working tree rather than stashing on the deployer's behalf.
- `frontend/.dockerignore` / `backend/.dockerignore` exist specifically to stop `node_modules`/module `target/` dirs from bloating the Docker build context on every rebuild — check these first if a build reports a suspiciously large context.
