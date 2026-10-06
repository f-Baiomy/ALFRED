# Contract: UI (must match mock.html, SC-008)

Colours: `--redis: #ff7a59` / `--redis-text: #ffd9cc` dark, `#c2410c` / `#1f2430` light themes. Glyph ⬢. All new
styles go in `frontend/src/styles/_db-capture.scss` (the mock's "NEW - Redis" block, unchanged class names).

| Mock section | Component / file | Notes |
|---|---|---|
| 1 ⬢ switch | `components/sources-bar` (+ `redis-sw`, `redis-glyph`) | after ▤; blocked with reason like ◆; state in `DbCaptureStateService.projectStatus().redisOn` |
| 2 chip | NEW `components/db-capture/redis-chip.component.ts` (`db-chip redis-chip`) | counts batched via a `CallStoreCountsService` (on-screen only, like `CallLogCountsService`); states: count/miss/failed, `· n ms`, `live`, `capture ended early`, muted `⬢ Redis 0`, none |
| 2 pill | `components/stats-bar` `✖ Redis failures` (`stat-pill db-failed`) + header filter option | `call-list-view.ts` `redisFailures` |
| 3 header/legend | `db-window.component.html` | `· 22 Redis · 25.4 ms`, summary `Redis 25 ms`, legend "1 shared connection (Lettuce) · no pool wait · 22 commands in 21 round trips" |
| 3 lane | `db-timeline.component.ts` | lane `Redis`, `k-redis` / `k-redis-miss` / failed red; hover card; click selects |
| 3 Redis view | NEW `components/db-capture/store-command-list.component.ts` + `store-command-detail.component.ts` | tabs `Redis n` (`rd`), filters All/Reads/Writes/Misses/Failed, search placeholder "Search SQL, key, value or log - e.g. fare:rule, 948", rows `.r.rd-row`, footer "Showing n of m Redis commands", Copy as redis-cli / Export .redis |
| 3 groups | `shared/utils/store-command-tree.ts` | `GET ×9` with "⚠ 9 GETs one by one - one MGET would do"; `MULTI ×2 · 1 round trip · EXEC OK` |
| 3 detail | `store-command-detail.component.ts` | kv rows in mock order; "Written by" box; Decoded/Raw bytes; Trace a value chips; tags |
| 3 Keys view | NEW `components/db-capture/store-keys.component.ts` | columns Key pattern / Commands / Reads / Writes / Hit / miss / Time / Last written by |
| 3 Together | `db-window.component.ts` merge | Redis rows and groups by `seq`; count/footer include Redis |
| 4 Findings | `shared/utils/db-findings.ts` + `db-findings.component.ts` | five Redis findings + KEYS/FLUSH note, texts as in mock |
| 5 Settings | `components/db-capture/db-capture-settings.component.ts` | Redis section rows in mock order; "Stored: every command and its full reply…" fixed text; masked patterns **empty by default** (the mock's `session:*, token:*` is an example a user typed - clarification Q3) |
| 7 health | none - Claude/API only | mock section 7's table is what `endpoint_health` returns; no ALFRED screen (clarified 2026-10-07) |

Values are always rendered through Angular bindings (no `innerHTML`); decoded text is call data.
