# Quickstart: check Redis capture end to end

Prerequisites: ALFRED running (`python3 start.py`), odeysys behind the reverse proxy with the db-agent attached
(`--db-capture on`), odeysys's inbound logging (●) on, odeysys using Redis.

1. **Switch on** - Live calls → Sources → odeysys → click ⬢. It lights; `proxy/redis-capture-enabled.flag` has
   `odeysys=on`.
2. **Make a call** - search upsell flights in odeysys (`POST …/flight-search/get-upselling-flights`).
3. **Card** - the call shows `⬢ Redis n` beside `◆ DB` and `▤ Logs`; with a failed command it is red and the
   `✖ Redis failures` pill counts it.
4. **Window** - click the chip: the Redis view lists every command in order; open one: full reply, Spring Cache tag
   and origin, value format, Decoded / Raw bytes, client/connection/server/db, thread, code line. A hit shows
   "Written by". The timeline has a Redis lane; Together interleaves Redis with statements, supplier calls and log lines.
5. **Keys / Findings** - Keys lists patterns with hit/miss and last writer; Findings shows the Redis checks.
6. **Settings** - ▾ → Redis: clients found (Lettuce …), Spring Cache names, masked patterns (empty), value before a
   write (off). Add `session:*`: the session GET now shows `‹masked · n B›`; turn on value before a write, make the
   call again: writes show "before the write".
7. **Exports** - export the call as .json, delete it from the list, re-import: the same commands (compare bytes of the
   1.8 MB `SET upsell:*` value with the original reply). .md/.html have a Redis section with full values.
8. **Claude** - ask "which calls had Redis failures in the last hour?" → `problem_calls` lists them; `redis_overview`
   on one call.
9. **Off** - click ⬢ off, make the call again: no Redis commands recorded, no chip.
10. **Size cap** - with `ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES=50000000` in `.env`, generate traffic past 50 MB: oldest
    calls lose their Redis commands whole; calls in a session cycle keep theirs.

Overhead check (SC-003): `OverheadMeasurementIT`'s Redis case - 100 commands per call, with and without ⬢ - reports
the added time per command and per call.
