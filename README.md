# Alfred

Logs every request/response your Java app sends to ANY supplier whose
configured URL ends in "-proxy" - url, method, headers, body, status,
and duration - as JSON lines to ./proxy/logs/calls.log.

Runs in reverse mode: your Java app needs ZERO configuration changes
(no proxy settings). One command handles everything else: hosts file
entries, starting the proxy, and trusting its certificate everywhere
it's needed (Windows/OS store + every JVM you list). Safe to re-run
any time - already-done steps are skipped automatically.

## One command, any OS

Maintain your suppliers in suppliers.txt and your JVMs in jdks.txt (see
below), then run, from an Administrator/root terminal:

    python3 start.py

Each run does all of the following, safe to repeat any time:
  1. Adds any missing "-proxy" hosts entries from suppliers.txt (skips
     ones already present)
  2. Runs "docker compose up -d --build" (generates the CA cert on
     first run in this project folder)
  3. Re-syncs that CA cert into the OS certificate store (always
     replaces any existing "mitmproxy"-named entry, since a different
     Alfred project folder would have a different CA under the same
     name - see note below)
  4. Re-syncs that CA cert into every JDK listed in jdks.txt, the same
     way

This detects your OS and delegates to the matching script:
  - Windows: start.ps1 (Windows cert store via certutil)
  - Linux/macOS: start.sh (system store via update-ca-certificates, or
    macOS Keychain)

NOTE ON MULTIPLE ALFRED FOLDERS: each project folder's proxy/certs/
directory holds its own unique CA, generated fresh the first time that
folder's container starts. If you run Alfred from more than one folder
(e.g. testing a v2 alongside an older copy), only ONE of their CAs can
usefully be trusted at a time per JDK/OS store, since both use the same
"mitmproxy" friendly name. Steps 3-4 always re-sync to whichever
folder's cert you last ran start.py from - if you switch folders,
re-run start.py in the new one before testing, and restart any running
Java app so it re-reads its truststore.

IMPORTANT LIMITATION: Docker containers cannot modify your host
machine's hosts file or certificate store directly - that's an
intentional isolation Docker enforces, especially on Windows where
Docker Desktop runs inside its own VM with no access to C:\Windows at
all. This is why start.py / start.sh / start.ps1 exist as a small
wrapper that runs on your actual machine (not inside a container)
before/alongside calling docker compose.

If you'd rather run the OS-specific script directly instead of the
Python wrapper:

    ./start.sh          (Linux/macOS, run with sudo)
    .\start.ps1          (Windows, run from an Administrator PowerShell)

If a JVM's cert import fails after running this (e.g. your app was
already running when you added it to jdks.txt), restart that app/server
so its JVM re-reads its truststore - a running JVM doesn't pick up
truststore changes live.

## Folder contents

    Alfred/
      docker-compose.yml     <- orchestrates all 3 services
      proxy/
        log_and_route.py       <- routing + logging addon
        logs/                     <- calls.log appears here after first run
        certs/                     <- CA certificate appears here after first run
      backend/                  <- pennyworth: serves the logged data over an API
        Dockerfile
        app.py
        requirements.txt
      frontend/                  <- manor: dashboard that queries pennyworth
        Dockerfile
        index.html
      suppliers.txt       <- list of real supplier domains (one per line)
      jdks.txt              <- list of JAVA_HOME paths needing cert trust
      start.py                <- cross-platform entry point (recommended)
      start.sh                  <- Linux/macOS: hosts + compose + cert trust
      start.ps1                   <- Windows: hosts + compose + cert trust
      README.md

## The three services

  - alfred (mitmproxy)   - intercepts and logs supplier calls, as before
  - pennyworth (backend) - reads proxy/logs/calls.log and serves it over
                            a small API (http://localhost:5000). Minimal
                            for now (GET /calls, GET /health) - scope to
                            be expanded once discussed further.
  - manor (frontend)     - dashboard at http://localhost:3000 that polls
                            pennyworth and displays recent calls. Current
                            version is a plain placeholder page, meant to
                            be replaced with a real UI.

python3 start.py builds and starts all three (docker compose up -d --build).

## How it works

    Your Java app calls (per its own supplier config):
      https://ndc-integration-stg-ne-3.azurewebsites.net-proxy:8444/...
      https://another-supplier.com-proxy:8444/...
            |
            v  (hosts file redirects "*-proxy" hostnames to 127.0.0.1)
      mitmproxy receives the direct HTTPS connection, terminates TLS
      using its own trusted CA, strips the "-proxy" suffix from the host
            |
            v
      forwards to the real host:
      https://ndc-integration-stg-ne-3.azurewebsites.net/...
      https://another-supplier.com/...
            |
            v
      logs full request + response, returns result to your app

  Your Java app never knows a proxy is involved - it thinks it's talking
  directly to "...-proxy", which is why no JVM/app proxy settings are
  needed. python3 start.py handles the hosts file entries and cert
  trust automatically (see above).

## Manual start (skips hosts/cert automation)

If you just want to (re)start the container without running the
hosts/cert steps again:

    docker compose up -d --build

python3 start.py handles this for you - no manual certutil/keytool
commands needed for normal use. It's safe to run repeatedly (it always
re-syncs to whichever project folder's CA currently exists, rather than
silently skipping based on name).

To have it trust the cert in your app's JVM(s) too, list each JVM's
JAVA_HOME in jdks.txt:

    C:\Program Files\Java\jdk1.8.0_191
    C:\work\java-upgrade\jdk-11.0.0.2

Multiple JDKs are common (e.g. an app server running JDK 8 while
another tool runs JDK 11/17) - list every one your app(s) might run
under. Find a running app's actual JDK with:

    Get-Process -Name java | Select-Object Id, Path      (Windows)
    ps aux | grep java                                    (Linux/macOS)

Then re-run python3 start.py and restart that app/server afterward.

## Managing suppliers (add/remove)

Edit suppliers.txt - one real domain per line, no "-proxy" suffix (the
scripts add it automatically):

    ndc-integration-stg-ne-3.azurewebsites.net
    supplier-two.example.com
    supplier-three.example.com

Then re-run:

    python3 start.py

Already-present hosts entries are left alone; only new ones are added.
You never need to manually edit the hosts file yourself.

## Configure your suppliers

Wherever each supplier's base URL is configured/stored as credentials in
your app, append "-proxy" plus the proxy's port to the hostname:

    https://ndc-integration-stg-ne-3.azurewebsites.net-proxy:8444/
    https://supplier-two.example.com-proxy:8444/
    https://supplier-three.example.com-proxy:8444/

Your Java app itself needs no other changes - no proxy settings, no code
changes. It just calls these URLs like any normal HTTPS endpoint.

(If you'd rather have no port in the URL, change the port mapping in
docker-compose.yml to "443:8080" instead of "8444:8080" - check nothing
else on your machine is already using port 443 first.)

## Watch the logs live

    Get-Content .\proxy\logs\calls.log -Wait -Tail 20

Pretty-printed with jq (if installed):

    Get-Content .\proxy\logs\calls.log -Wait -Tail 20 | jq .

Or view them in the browser via the manor dashboard: http://localhost:3000

Each entry includes both the URL your app called and the real URL it was
forwarded to:

    {
      "original_url": "https://ndc-integration-stg-ne-3.azurewebsites.net-proxy/v1/offers",
      "url": "https://ndc-integration-stg-ne-3.azurewebsites.net/v1/offers",
      "method": "POST",
      "request": { "headers": {...}, "body": "..." },
      "timestamp": "2026-08-06T21:47:00.123456+00:00",
      "duration_ms": 210.4,
      "response": { "status": 200, "headers": {...}, "body": "..." }
    }

## Stop / restart

    docker compose down
    python3 start.py    (re-adds any new suppliers.txt entries, then starts back up)

## Change the port

Edit the left side of the ports mapping in docker-compose.yml (host port),
then update the port used in each supplier's "-proxy" URL to match:

    ports:
      - "8444:8080"

## Change the log file name/location

Edit LOG_FILE in docker-compose.yml, e.g.:

    environment:
      - LOG_FILE=/home/mitmproxy/logs/my-custom-name.log

Since ./proxy/logs is mounted to /home/mitmproxy/logs, the filename you choose
appears on your host under .\proxy\logs\ automatically.
