# WildFly proxy toggle

Routes an **already-running** WildFly JVM's HTTPS traffic through Alfred's forward-mode proxy (`127.0.0.2:443` by default), and back off again — without restarting WildFly, without editing `standalone.xml` by hand, and without touching your IntelliJ run configuration, `pom.xml`, or application code.

## How it works

The actual work happens in `WildflyProxyToggle.java` (plain Java 8, no dependencies) - `proxy-on.bat`/`proxy-on.sh`/`proxy-off.bat`/`proxy-off.sh` are thin wrappers that compile it (if needed - a fresh compile every run is cheap, so there's no staleness-checking to get wrong) and invoke it with `on`/`off`.

`WildflyProxyToggle` scans running processes for a java process with `org.jboss.as.standalone` on its command line (WildFly's own standalone-mode bootstrap main class) - **no `WILDFLY_HOME` needed**:

- **Exactly one found** → used automatically.
- **More than one found** → you're prompted to pick which one, by PID.
- **None found** → fails with a clear message (unless `WILDFLY_HOME`/`CONTROLLER` are set manually as a fallback - e.g. if WildFly is running as a different user or in a container where this process can't see it).

From the chosen instance's own command line it extracts the management port (`-Djboss.management.http.port=`, or `-Djboss.socket.binding.port-offset=` added to WildFly's default 9990, or just 9990 if neither is set) and its install directory (`-Djboss.home.dir=`), then adds `https.proxyHost`/`https.proxyPort` as WildFly system properties via the management CLI (`jboss-cli`) - which, for a standalone server that's already running, calls `System.setProperty(...)` on that live JVM immediately. `off` removes them again.

This *does* briefly write those two properties into `standalone.xml` while the proxy is on (that's how standalone-mode management works - the file is the live config), and reverts it on `proxy-off`. If that's not acceptable for your setup, use an Attach-API-based Java agent instead, which has zero `standalone.xml` footprint at any point - ask if you want that built.

## Prerequisites

- Some JDK on `PATH` or `JAVA_HOME` to run the toggle tool itself - Java 8+ is enough (targets Java 8 deliberately). This is independent of whatever JDK WildFly itself runs on; it's a separate process.
- WildFly's management interface reachable on whatever port it's actually using (auto-detected, see above).
- Whatever HTTP client your app actually uses needs to read these JVM properties dynamically to begin with. Plain `HttpURLConnection`-based clients (including a default, unconfigured `RestTemplate`) do. Apache HttpClient only does if it was explicitly built with `.useSystemProperties()`/`SystemDefaultRoutePlanner` - if you're not sure, turn the proxy on and make one test call to confirm it shows up in Alfred's dashboard before relying on this for real debugging.
- The JDK this WildFly instance runs under needs to already trust Alfred's CA (`proxy/certs/mitmproxy-ca-cert.pem`) **before** you use this toggle - a running JVM doesn't pick up a trust-store change live, so if that JDK isn't already in this repo's `jdks.txt` and synced via `start.py`, you'll need one restart to pick up the cert trust before this toggle is useful going forward.

## Usage

**Windows:**
```bat
wildfly-proxy-toggle\proxy-on.bat
:: ... test your HTTPS calls, check Alfred's dashboard ...
wildfly-proxy-toggle\proxy-off.bat
```

**Linux/macOS:**
```bash
./wildfly-proxy-toggle/proxy-on.sh
# ... test your HTTPS calls, check Alfred's dashboard ...
./wildfly-proxy-toggle/proxy-off.sh
```

Both idempotent - safe to run `proxy-on` twice in a row, or `proxy-off` when the proxy was never on.

**Via `start.py`/`restart.py`** (repo root) instead of calling these directly - same environment variables apply:
```bash
python3 start.py --wildfly-proxy on
python3 restart.py --wildfly-proxy off
python3 restart.py backend --wildfly-proxy on   # combinable with restart.py's service-name args
```

## Optional overrides (env vars)

None of these are required for the common case (one WildFly instance running, visible to this user) - they're fallbacks/overrides for everything else.

| Variable | Meaning |
|---|---|
| `WILDFLY_PID` | Skip the interactive prompt and pick this specific detected PID (useful for non-interactive/scripted use when more than one instance is running) |
| `WILDFLY_HOME` | Manual fallback for locating `jboss-cli` if detection can't determine a candidate's install directory, or if no WildFly process was detected at all |
| `CONTROLLER` | Manual override for the management interface address (`host:port`) instead of the one auto-detected from the chosen instance |
| `PROXY_HOST` | Alfred's forward-proxy listener address (default `127.0.0.2`) |
| `PROXY_PORT` | Alfred's forward-proxy listener port (default `443`) |

If WildFly's management interface requires authentication beyond the default local/same-machine mechanism, that's not currently handled here - ask if you need `--user`/`--password` support added.
