# WildFly proxy toggle

Routes an **already-running** WildFly JVM's HTTPS traffic through Alfred's forward-mode proxy (`127.0.0.2:443` by default), and back off again — without restarting WildFly, without editing `standalone.xml` (not even transiently), and without touching your IntelliJ run configuration, `pom.xml`, or application code.

## How it works

Two small Java 8 classes, no dependencies beyond the JDK:

- **`WildFlyProxyController.java`** — runs as a normal short-lived process. Uses the Java Attach API (`com.sun.tools.attach.*`) to find the running WildFly instance: it attaches briefly to every running java process and checks for a `jboss.home.dir` system property (more precise than matching free-text process names). Exactly one match is used automatically; more than one prompts you to pick by PID.
- **`WildFlyProxyAgent.java`** — loaded *into* the chosen WildFly JVM via `VirtualMachine.loadAgent(...)`, using the standard Java Instrumentation agent mechanism. Its `agentmain()` calls `System.setProperty("https.proxyHost", ...)`/`System.setProperty("https.proxyPort", ...)` directly, in-process — the same guarantee as if the JVM had been launched with `-Dhttps.proxyHost=...` in the first place, just applied after the fact.

These are deliberately two separate classes: the target JVM has to load and verify `WildFlyProxyAgent`'s method signatures to find `agentmain()`, and it has no `tools.jar` on its own classpath to resolve `com.sun.tools.attach.*` types with — confirmed live, mixing them into one class throws `NoClassDefFoundError` inside the target even though `agentmain()` itself never touches the Attach API.

Unlike a jboss-cli/management-CLI-based approach, this **never needs to locate WildFly's management port, and doesn't require the management interface to be enabled at all** — it's a normal in-process property write, not a remote management operation. `status` doesn't even need the agent: `VirtualMachine.getSystemProperties()` reads the target's properties directly over the same Attach API connection used for detection.

## Prerequisites

- **`JAVA_HOME` must point at a JDK 8 install** (needs `tools.jar`, which only JDK 8 ships — this is the only JDK available in this environment; a `tools.jar`-free JDK 9+ Attach API story would need `ProcessHandle`-based detection instead, ask if that's ever needed). This is independent of whatever JDK WildFly itself runs on.
- Whatever HTTP client your app actually uses needs to read `https.proxyHost`/`https.proxyPort` dynamically to begin with. Plain `HttpURLConnection`-based clients (including a default, unconfigured `RestTemplate`) do. Apache HttpClient only does if it was explicitly built with `.useSystemProperties()`/`SystemDefaultRoutePlanner` — if you're not sure, turn the proxy on and make one test call to confirm it shows up in Alfred's dashboard before relying on this for real debugging.
- The JDK this WildFly instance runs under needs to already trust Alfred's CA (`proxy/certs/mitmproxy-ca-cert.pem`) **before** you use this toggle — a running JVM doesn't pick up a trust-store change live, so if that JDK isn't already in this repo's `jdks.txt` and synced via `start.py`, you'll need one restart to pick up the cert trust before this toggle is useful going forward.

## Usage

**Windows:**
```bat
set JAVA_HOME=C:\Program Files\Java\jdk1.8.0_XXX
wildfly-proxy-toggle\proxy-on.bat
wildfly-proxy-toggle\proxy-status.bat
:: ... test your HTTPS calls, check Alfred's dashboard ...
wildfly-proxy-toggle\proxy-off.bat
```

**Linux/macOS:**
```bash
export JAVA_HOME=/opt/jdk1.8.0_XXX
./wildfly-proxy-toggle/proxy-on.sh
./wildfly-proxy-toggle/proxy-status.sh
# ... test your HTTPS calls, check Alfred's dashboard ...
./wildfly-proxy-toggle/proxy-off.sh
```

Both `on`/`off` are idempotent — safe to run `proxy-on` twice in a row, or `proxy-off` when the proxy was never on. `agentmain`'s own confirmation prints into the *target* JVM's console (e.g. IntelliJ's WildFly run window), not the terminal you ran the script from — the controller prints its own independent confirmation either way.

**Via `start.py`/`restart.py`** (repo root) instead of calling these directly — same environment variables apply:
```bash
python3 start.py --wildfly-proxy on
python3 restart.py --wildfly-proxy off
python3 restart.py backend --wildfly-proxy on   # combinable with restart.py's service-name args
```

## Optional overrides (env vars)

None of these are required for the common case (one WildFly instance running, visible to this user) — they're fallbacks/overrides for everything else.

| Variable | Meaning |
|---|---|
| `JAVA_HOME` | **Required** — a JDK 8 install (needs `tools.jar`) |
| `WILDFLY_PID` | Skip the interactive prompt and pick this specific detected PID (also needed for non-interactive/scripted use when more than one instance is running — the controller refuses to guess rather than hang waiting on a prompt that'll never come) |
| `PROXY_HOST` | Alfred's forward-proxy listener address (default `127.0.0.2`) |
| `PROXY_PORT` | Alfred's forward-proxy listener port (default `443`) |

## Known limitation

Once `WildFlyProxyAgent`'s jar is loaded into a JVM, that JVM keeps its file handle open (and locked, on Windows) for the JVM's remaining lifetime — confirmed live. The wrapper scripts build a freshly-named jar (`wildfly-agent-<random>.jar`) on every run specifically to avoid colliding with one a still-running instance already has open; `out/`'s jars accumulate slightly over repeated runs against a long-lived WildFly instance as a result. Harmless (gitignored build output), but delete `wildfly-proxy-toggle/out/` occasionally if it bothers you — anything currently loaded will simply fail to delete until that JVM exits.
