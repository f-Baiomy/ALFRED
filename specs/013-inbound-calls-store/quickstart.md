# Quickstart: verifying the feature

Docker install, Git Bash, repo root. JDK tools are attached through the backend's PID namespace (the image is a JRE).

## Baseline (2026-10-09, Docker install, before this feature)

| measure | value |
|---|---|
| backend heap limit | 1 GB (`MaxRAMPercentage=50` of `mem_limit: 2g`) |
| live heap after forced full GC | 835 MB (old gen 79.8 %); `byte[]` 680 MB |
| full GCs in ~20 quiet minutes | 5 |
| inbound retention / file | 7,000 rows / `internal-calls.log` 467 MB, 10,031 lines |
| copy of that file on the bind mount | 6.7 s (read alone 2.5 s) |
| list read (`/internal-calls?limit=50`), idle and right after appends | 10-15 ms |
| report timeout | 2 s, no retry; failure lines buffered until container restart |

## End-to-end suite (isolated stack)

```bash
sh tests/e2e/run_inbound_e2e.sh            # all scenarios; or: sh tests/e2e/run_inbound_e2e.sh E2 E6
```

Builds the images, starts `alfred-e2e` (own container names, host ports 13000/15000/18080/127.0.0.3:18443, data under
`tests/e2e/.work/`), runs `tests/e2e/inbound_store_e2e.py`, prints `PASS`/`FAIL` per step and always runs
`docker compose -p alfred-e2e ... down -v`. The owner's running Alfred is never touched.

## Stories 1-2: reports survive a stall and failures are visible

```bash
docker compose up -d --build backend && docker compose restart reverse-proxy proxy app-gateway
# Stall the backend for 10 s while sending calls through the reverse proxy (odeysys listener on 8080):
docker pause backend; for i in $(seq 1 20); do curl -s -o /dev/null -X OPTIONS http://127.0.0.1:8080/odeysysadmin/x & done; sleep 10; docker unpause backend
docker logs --since 1m reverse-proxy | grep "\[webhook\]"      # attempts logged as they happen, none "given up"
```

Expected: every probe call appears in the live list complete (method, URL, time, request, response); attempt lines
appear within seconds, not at restart (SC-001, SC-002). Stop the backend for 90 s instead to see "given up" lines.

Restart case (SC-001): `( for i in $(seq 1 30); do curl -s -o /dev/null -X OPTIONS http://127.0.0.1:8080/odeysysadmin/x; sleep 1; done ) & docker restart backend; wait`
- every one of the 30 calls is stored complete once the backend is back.

## Story 3: heap share

```bash
MSYS_NO_PATHCONV=1 docker run --rm --pid=container:backend maven:3.9-eclipse-temurin-21 \
  sh -c 'jcmd 1 VM.flags | tr " " "\n" | grep MaxHeapSize; jcmd 1 GC.class_histogram >/dev/null; jstat -gcutil 1'
```

Expected: `MaxHeapSize` 1.5 GB; old gen after the forced GC <= 60 % with 7,000 retained calls (SC-003).

## Story 4: SQLite store

```bash
docker logs backend | grep -i "migrated"            # "Migrated N inbound call(s) ... in X s"
docker exec backend ls -la /appdata | grep internal-calls   # internal-calls.db, internal-calls.log.migrated
curl -s "http://localhost:3000/internal-calls?limit=5" | head -c 400
```

Expected: N = min(retention, lines in the old file); live list, search, triage, cycles, exports unchanged; old file
kept as `.migrated` (SC-006). Memory: repeat the Story 3 check at 1,500 and 20,000 retained calls - within 10 %
(SC-004). Report answers stay under 1 s while retention trims (SC-005).

Load and burst (SC-004, SC-005, burst edge case) - **never against the real store** (20,000 fake calls would push
the owner's real calls out through retention). Start a throwaway backend from the same image with an empty data
folder, then `scripts/inbound_load.py` posts prepare+complete webhooks with realistic ~60 KB bodies to it:

```bash
docker run -d --name alfred-loadtest -p 127.0.0.1:5099:5000 -m 2g -e WEBHOOK_SECRET=loadtest   -e INTERNAL_CALLS_RETENTION_ROWS=20000 -v alfred-loadtest-data:/appdata alfred-backend
python scripts/inbound_load.py --url http://127.0.0.1:5099 --secret loadtest --calls 20000 --concurrency 8   # p50/p95/max report latency
python scripts/inbound_load.py --url http://127.0.0.1:5099 --secret loadtest --calls 200 --concurrency 200   # burst: expects 200/200 stored
docker rm -f alfred-loadtest && docker volume rm alfred-loadtest-data
```

Run the Story 3 memory check (with `--pid=container:alfred-loadtest`) at 1,500 and at 20,000 retained calls, and
record the database size per 1,000 calls.

Exports (FR-013): export one session cycle as .json, re-import it, compare call count and one body byte-for-byte.

Fallback: `INTERNAL_CALLS_STORAGE=file` in `.env`, restart backend - today's file store.

## Results

### MVP (US1 + US2), 2026-10-09

- Delivery rules live in one shared module, `proxy/webhooks.py`, used by both addons (a single implementation
  instead of the per-addon `_deliver` the tasks described).
- Proxy tests: 465 passed (`proxy/test_webhook_delivery.py` new). `backend-internal-calls` 54/54, `backend-calls`
  150/150 (outbound prepare now `ON CONFLICT DO NOTHING`), launcher `test_supervisor.py` 19/19 (native proxies already
  ran unbuffered).
- E2E on the isolated stack: E1-E5 PASS. E2: first failed attempt visible after 15.7 s while the backend was still
  paused; 20/20 stored complete after a 20 s stall, nothing given up. E3: 30/30 across a restart. E4: traffic answered
  in < 0.04 s with the backend down; "given up" logged. E5: outbound call during a stall stored.
- Deployed to the owner's Docker install (proxy + reverse-proxy recreated: `webhooks.py` mounted,
  `PYTHONUNBUFFERED=1`). The stop-the-backend check (T016) was run on the isolated stack (E2/E4) rather than on the
  owner's live stack, so their Alfred was not taken down.

### US3 heap share, 2026-10-09

- E9 PASS: MaxHeapSize 1,610,612,736 = 75.0 % of the 2 GB limit.
- Owner's install after rebuild, 7,000 retained inbound calls, forced full GC: 689 MB used of 1.5 GB max - **55 %
  free** (SC-003 target >= 40 %; baseline 15 %).
