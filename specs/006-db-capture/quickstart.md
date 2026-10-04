# Quickstart: Database Capture

How to build, attach and verify the feature end to end once it is implemented. Commands are Git Bash; the repo
root is `C:\projects\Alfred\Alfred`.

## 1. Build

```bash
# The agent (Java 8 bytecode, ByteBuddy shaded) - built in Docker like the backend (bare mvn may be JDK 8 here)
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/repo" -v alfred-m2:/root/.m2 -w //repo/db-agent maven:3.9-eclipse-temurin-21 mvn -B package
# -> db-agent/target/alfred-db-agent.jar

# Backend, proxies, frontend, gateway
docker compose up -d --build
docker compose restart app-gateway   # see CLAUDE.md: after a backend rebuild the gateway may keep the old IP
```

## 2. Attach to a running WildFly

```bash
python3 start.py --db-capture on            # finds WildFly (Attach API), loads the agent with alfredUrl/project/secretFile
# or directly:
wildfly-proxy-toggle/db-capture-on.sh
```

Or at startup: add to `standalone.conf(.bat)`
`-javaagent:C:/projects/Alfred/Alfred/db-agent/target/alfred-db-agent.jar=alfredUrl=http://localhost:3000;project=wallet-app;secretFile=C:/projects/Alfred/Alfred/.env`

Expected: Live Calls → Sources bar → `wallet-app ▾` shows "● attached" within 10 s.

## 3. Turn it on and see a call

1. Make sure the project's inbound logging dot is green.
2. Click the project's `◆` switch (or the cycle widget's **Log DB**, or Settings → Database capture). All three
   show it on.
3. Call the app through its reverse-proxy port (callers stay on `localhost`).
4. The call card shows `◆ DB n · …`. Click it: the database window lists the statements in order, with supplier
   calls between them.

## 4. Verify the success criteria

| Check | How |
|---|---|
| SC-001 attribution | `db-agent` test `ConcurrentAttributionIT` (50 threads × H2) + manual: fire 50 parallel calls with a load script, open five at random, statements match each call's own params |
| SC-002 overhead | `db-agent` `OverheadMeasurementTest` (50-statement call, capture off vs on, 1,000 iterations) - record numbers in `docs/db-capture.md` |
| SC-003 ALFRED down | `docker compose stop backend`, call the app: same responses, no added latency; agent logs one WARN/minute |
| SC-005 big window | open the reference call with 500 statements (< 1 s); scroll all 50,000 stored rows of a 100,000-row result end to end; the note says 50,000 were not kept |
| SC-007 flags | backend `StatementFlagsTest` over the reference recordings |
| SC-008 exports | export the call as .json/.md/.html; existing no-truncation guards + re-import round trip |
| SC-009 switches | toggle in Sources bar with Settings and the cycle widget open in other tabs |
| SC-010 vendors | `db-agent` codec tests per vendor; manual run against each database's container (Oracle Free, PostgreSQL, MySQL, SQL Server) |

## 5. Tests

```bash
cd backend && mvn test        # or the Docker command in CLAUDE.md; includes ArchUnit isolation for backend-db-capture
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/repo" -v alfred-m2:/root/.m2 -w //repo/db-agent maven:3.9-eclipse-temurin-21 mvn -B verify
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/repo" -w //repo/db-agent eclipse-temurin:8-jdk java -jar target/alfred-db-agent-selftest.jar   # Java 8 runtime check
cd proxy && python -m pytest test_db_capture_headers.py
cd frontend && npm test && npm run build
```
