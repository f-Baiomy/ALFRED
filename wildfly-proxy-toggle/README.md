# WildFly proxy toggle

Routes an **already-running** WildFly JVM's HTTPS traffic through Alfred's forward-mode proxy (`127.0.0.2:443` by default), and back off again — without restarting WildFly, without editing `standalone.xml` by hand, and without touching your IntelliJ run configuration, `pom.xml`, or application code.

## How it works

`proxy-on.sh`/`proxy-on.bat` add `https.proxyHost`/`https.proxyPort` as WildFly system properties via the management CLI (`jboss-cli`), which - for a standalone server that's already running - calls `System.setProperty(...)` on that live JVM immediately. `proxy-off.sh`/`proxy-off.bat` remove them again.

This *does* briefly write those two properties into `standalone.xml` while the proxy is on (that's how standalone-mode management works - the file is the live config), and reverts it on `proxy-off`. If that's not acceptable for your setup, use an Attach-API-based Java agent instead, which has zero `standalone.xml` footprint at any point - ask if you want that built.

## Prerequisites

- WildFly's management interface reachable (default `localhost:9990`) - true out of the box for most dev setups.
- Whatever HTTP client your app actually uses needs to read these JVM properties dynamically to begin with. Plain `HttpURLConnection`-based clients (including a default, unconfigured `RestTemplate`) do. Apache HttpClient only does if it was explicitly built with `.useSystemProperties()`/`SystemDefaultRoutePlanner` - if you're not sure, turn the proxy on and make one test call to confirm it shows up in Alfred's dashboard before relying on this for real debugging.
- The JDK this WildFly instance runs under needs to already trust Alfred's CA (`proxy/certs/mitmproxy-ca-cert.pem`) **before** you use this toggle - a running JVM doesn't pick up a trust-store change live, so if that JDK isn't already in this repo's `jdks.txt` and synced via `start.py`, you'll need one restart to pick up the cert trust before this toggle is useful going forward.

## Usage

**Windows:**
```bat
set WILDFLY_HOME=C:\wildfly-30.0.0.Final
wildfly-proxy-toggle\proxy-on.bat
:: ... test your HTTPS calls, check Alfred's dashboard ...
wildfly-proxy-toggle\proxy-off.bat
```

**Linux/macOS:**
```bash
export WILDFLY_HOME=/opt/wildfly
./wildfly-proxy-toggle/proxy-on.sh
# ... test your HTTPS calls, check Alfred's dashboard ...
./wildfly-proxy-toggle/proxy-off.sh
```

Both scripts are idempotent - safe to run `proxy-on` twice in a row, or `proxy-off` when the proxy was never on.

**Via `start.py`/`restart.py`** (repo root) instead of calling these directly - same environment variables apply:
```bash
python3 start.py --wildfly-proxy on
python3 restart.py --wildfly-proxy off
python3 restart.py backend --wildfly-proxy on   # combinable with restart.py's service-name args
```

## Optional overrides (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `WILDFLY_HOME` | *(required)* | WildFly install directory (contains `bin/jboss-cli.sh`/`.bat`) |
| `CONTROLLER` | `localhost:9990` | WildFly management interface address |
| `PROXY_HOST` | `127.0.0.2` | Alfred's forward-proxy listener address |
| `PROXY_PORT` | `443` | Alfred's forward-proxy listener port |

If WildFly's management interface requires authentication, add `--user=<user> --password=<pass>` to the `jboss-cli` invocation inside these scripts (not stored here deliberately - don't commit credentials).
