# SPIKE S3: trusting Alfred's CA inside a running JVM

**Date**: 2026-10-07. **Result**: PASS on JDK 8, 11, 17 and 21, for all three HTTP clients, including
clients created before the attach.

## What ran

`s3/S3Target.java` (Java 8 source) hosts an HTTPS server whose certificate a test CA signed. Before
anything is attached it builds three clients and calls the server with each:

- `HttpsURLConnection` (the default `SSLSocketFactory`, already initialised by that first call),
- Apache HttpClient 4.5.14 `HttpClients.createSystem()` (`useSystemProperties`),
- the JDK `HttpClient.newHttpClient()` (11+).

Then `attach-cli.jar` on JDK 21 loads `alfred-agent.jar` with `features=proxy` and `ALFRED_AGENT_CA`
set to the test CA. The target calls again with the **same client objects**. `s3/run.sh` runs it in
one container per JDK (target JDK from the image, attacher from a JDK 21 volume).

| Target JDK | HttpsURLConnection | Apache HC 4 (createSystem) | JDK HttpClient |
|---|---|---|---|
| 1.8.0_504 | refused, then **200** | refused, then **200** | n/a |
| 11.0.32.1 | refused, then **200** | refused, then **200** | refused, then **200** |
| 17.0.20.1 | refused, then **200** | refused, then **200** | refused, then **200** |
| 21.0.12 | refused, then **200** | refused, then **200** | refused, then **200** |

"Refused" is `SunCertPathBuilderException` (unknown CA), the error an app would hit through the
forward proxy without the CA in its trust store.

## Why it works

Every client above ends in the JDK's own `sun.security.ssl.X509TrustManagerImpl`, whatever SSL context
or connection pool it built earlier. The advice is on that class's `checkServerTrusted` overloads, so
existing objects are covered as soon as the class is retransformed. The advice only drops a refusal
when the chain verifies against Alfred's CA (`AlfredCaTrust`); `TrustAdviceIT` shows a chain from
another CA is still refused, and that clearing the bridge (feature off) restores the JDK's answer.

## Limits (docs/server.md "Attach limits")

- An app with its **own** `X509TrustManager` implementation (or certificate pinning) never reaches
  `X509TrustManagerImpl` for its decision, so the advice cannot help. Such an app needs Alfred's CA in
  its trust store (start.py's `jdks.txt` route, or `-Djavax.net.ssl.trustStore`).
- Routing is separate from trust: the JDK `HttpClient` built without a `ProxySelector` and Apache
  clients built without `useSystemProperties` ignore `http(s).proxyHost`, so the proxy feature does not
  route them even though their TLS would now be trusted.
- JDK 21 prints `WARNING: A Java agent has been loaded dynamically` on the target's console. It is a
  warning only; `-XX:+EnableDynamicAgentLoading` silences it.
