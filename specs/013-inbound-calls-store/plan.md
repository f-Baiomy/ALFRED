# Implementation Plan: Inbound calls that survive a busy backend

**Branch**: `013-inbound-calls-store` | **Date**: 2026-10-09 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/013-inbound-calls-store/spec.md`

## Summary

Inbound call reports were lost or half-stored when the backend stalled past the proxy's 2 s report timeout. The
stalls come from keeping every retained inbound call in memory (835 MB live of a 1 GB heap at 7,000 calls) and from a
whole-file rewrite (6.7 s on the Docker Desktop mount) that blocks every report. Plan, in shipping order:

1. **Reports** (P1): both proxies wait 15 s per attempt and retry retryable failures 3 times (2/5/10 s) on their
   existing background worker; every failure line is flushed immediately.
2. **Heap** (P2): Docker heap share 50 % -> 75 % (1.5 GB of the unchanged 2 GB). Native already runs a 2 GB heap.
3. **Store** (P2): a SQLite adapter for `backend-internal-calls` (default; the file adapter stays as `type=file`),
   with prepare/complete as order-independent upserts, count + 10 GB size retention trimmed in small batches, and a
   one-time migration of the retained calls from `internal-calls.log`.

## Technical Context

**Language/Version**: Java 21 (backend), Python 3 / mitmproxy addons (proxies)
**Primary Dependencies**: Spring Boot 3 (`JdbcTemplate`), SQLite JDBC (already used by `backend-calls` etc.), mitmproxy
**Storage**: new `internal-calls.db` (SQLite, WAL, incremental auto-vacuum, FTS5 trigram); `internal-calls.log` kept as the `file` fallback and migrated once
**Testing**: JUnit 5 + AssertJ + Mockito (`@TempDir` for adapters), ArchUnit, pytest for proxy addons; Docker JDK 21 build for the full reactor; **E2E**: `tests/e2e/inbound_store_e2e.py` against a throwaway `alfred-e2e` Docker stack (real compose + override, fake upstream app), plus one inbound check added to the native-install E2E (research R9)
**Target Platform**: Docker install (Linux container on Docker Desktop/Windows host bind mount) and the native install (Windows/Linux, supervisor)
**Project Type**: web service (backend slices) + proxy addons
**Performance Goals**: every report answered < 1 s including during retention trims (SC-005); memory flat from 1,500 to 20,000 retained calls (SC-004); migration of 7,000 calls < 5 min (SC-006)
**Constraints**: nothing on the proxied request path waits on a report; no whole-store rewrite or in-memory materialization; container `mem_limit` stays 2 GB
**Scale/Scope**: ~67 KB average inbound call here (some multi-MB); retention 7,000 here, 1,500 default; bursts of hundreds of concurrent calls

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* - **PASS (pre and post design)**

- [x] **I. Security**: no new endpoint; webhook secret check unchanged; new proxy log lines carry ids, phase, attempt
  and reason only - never bodies, headers or the secret; retries do not resend to any new destination; DB file in the
  existing data location with the same permissions as `calls.db`.
- [x] **II. Performance**: retries live on the existing worker thread, never on the request path (the one synchronous
  Relive prepare gets no retries); list/search are windowed SQL on a body-free metadata table with FTS and `LIMIT`;
  every `readAll()`-based port default gets a SQL override; retention trims <= 200 rows per pass, never a rewrite;
  retention defined (count + size); figures cited from measurements (research R1).
- [x] **III. Architecture**: owned by `backend-internal-calls` (`adapter.out.sqlite`); hexagonal layout kept; **no new
  cross-slice edge**; SQLite default via `@ConditionalOnProperty(prefix="alfred.storage.internal-calls", name="type",
  havingValue="sqlite", matchIfMissing=true)` with the file adapter on `havingValue="file"` - bringing this slice in
  line with the documented norm it was the exception to; no frontend change expected (verify in-progress rows render).
- [x] **IV. Style**: `SqliteInternalCallLogAdapter` / `SqliteInternalCallsRepository` naming, constructor injection,
  records, SLF4J; proxy changes follow the existing `_send_webhook` shape in both addons.
- [x] **V. Clean code**: reuses the outbound slice's proven design (named in research R5); copying it is the documented
  slice rule, recorded below; no speculative options beyond the spec's settings.
- [x] **VI. Verification**: adapter contract tests run against both stores (`@TempDir`); service tests with mocked
  ports; migration tests on files with malformed/id-less/tombstoned lines; pytest for retry/ordering/flush; ArchUnit;
  E2E scenarios E1-E10 on an isolated Docker stack covering every story end to end (stall, restart, outage, forward
  proxy, migration, file-vs-SQLite parity incl. exports, retention, heap, identity bounds) and the native install;
  measured checks from quickstart for SC-001..SC-006.
- [x] **Invariants**: exports untouched (they read through the same ports); no new route prefix; interception stays in
  the addons; docs updated in the same change (research R8).

## Project Structure

### Documentation (this feature)

```text
specs/013-inbound-calls-store/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── webhooks.md
│   └── settings.md
├── checklists/requirements.md
└── tasks.md            # /speckit-tasks
```

### Source Code (repository root)

```text
proxy/
├── log_and_route_reverse.py      # timeout 15 s, retry policy, flushed failure lines
├── log_and_route.py              # same policy (forward proxy)
└── test_webhook_delivery.py      # new: retry/ordering/no-retry-on-4xx/flush

scripts/inbound_load.py           # new: webhook load/burst generator, run only against a throwaway backend

tests/e2e/
├── inbound_store_e2e.py          # new: E1-E10 against the isolated alfred-e2e stack (PASS/FAIL steps)
├── compose.e2e.yml               # new: override - own names, ports, data dir, e2e-upstream service
├── e2e.env                       # new: E2E-only settings (secret, project, retention, store type)
├── upstream_app.py               # new: echo app behind the reverse proxy
├── run_inbound_e2e.sh            # new: build, up, run scenarios, down -v (always tears down)
└── native_install_e2e.py         # + inbound call stored in <data>/internal-calls.db

backend/Dockerfile                # MaxRAMPercentage 50 -> 75
docker-compose.yml                # PYTHONUNBUFFERED for both proxies; INTERNAL_CALLS_* env; comments
settings.properties               # new inbound store settings + comments

backend/backend-internal-calls/src/main/java/com/fathy/alfred/backend/internalcalls/
├── adapter/out/filelog/InternalCallsFileLogAdapter.java   # @ConditionalOnProperty(type=file); idempotent repeat complete
├── adapter/out/sqlite/
│   ├── SqliteInternalCallLogAdapter.java                  # port wiring + one-time migration (+ RetentionPort)
│   ├── SqliteInternalCallsRepository.java                 # schema, upserts, queries, retention
│   └── BatchWriter.java                                   # single-writer group commit (from backend-calls)
└── application/...                                        # unchanged ports/services (326ac85b already added prepareOrMerge/known)

backend/backend-internal-calls/src/test/java/.../adapter/out/
├── InternalCallStoreContractTest.java                     # abstract: today's file-adapter scenarios
├── filelog/InternalCallsFileLogAdapterTest.java           # extends contract + file-only cases
└── sqlite/SqliteInternalCallsRepositoryTest.java          # extends contract + upsert order, retention, migration

backend/backend-app/src/main/resources/application.properties   # alfred.storage.internal-calls.type=sqlite
packaging/launcher/supervisor.py                                 # INTERNAL_CALLS_DB_FILE -> data dir; proxies unbuffered
CLAUDE.md, AGENTS.md, docs/architecture.md, docs/supplier-integrations.md, docs/server.md
```

**Structure Decision**: all backend work stays inside `backend-internal-calls`; proxy work in the two addons; config
in the existing compose/Dockerfile/settings/supervisor files. Delivery order = spec story order: (1) reports,
(2) heap, (3) store - each shippable alone, each closed by its E2E scenarios passing on the isolated stack.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| SQLite repository + `BatchWriter` logic copied from `backend-calls` (V. "one implementation per behavior") | Slices must not share code (III, `docs/architecture.md`); the inbound slice needs the same proven writer/retention behaviour | Moving `BatchWriter` into `backend-platform` would create the first shared persistence code across slices and change `backend-calls` for no user value; writing a new design from scratch would re-learn the outbound slice's documented incidents (readAll trap, mapper drift, auto-vacuum) |
