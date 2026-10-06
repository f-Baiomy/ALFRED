# Feature Specification: Redis linked to calls

**Feature Branch**: `011-redis-capture`
**Created**: 2026-10-07
**Status**: Draft
**Input**: User description: "now for redis calls .. i want to log them also related to calls just like how you log db statements and logs" - record every Redis command the application sends while it serves a call, show it with that call next to its database statements, supplier calls and log lines, and keep it complete enough that a later Relive can answer Redis from the recording. Agreed design: `specs/011-redis-capture/mock.html` (this spec must match it).

## Context

ALFRED already records, for every inbound call into a project such as odeysys, the HTTP request and response, the supplier calls it made, the database statements it ran (◆, specs/006-db-capture) and the log lines it wrote (▤, specs/008-logs-call-link). The same application also talks to Redis - sessions, rate limits, caches (often through Spring Cache), locks, published events - and none of that is visible today. When a call is slow or wrong because a cache missed, a value was stale, a script failed or a huge value was written, the user cannot see it in ALFRED.

Redis does not speak HTTP, so the proxies cannot see it. The agent already attached to the application for database capture knows which call each request belongs to; this feature makes it record the Redis commands of that call the same way it records statements, and shows them everywhere statements and log lines are shown.

The owner intends to use the recording later in the Relive module, to answer Redis from it instead of a real Redis. **Relive replay is not part of this feature**, but nothing captured here may be dropped, shortened or altered in a way that would make that impossible (FR-050 to FR-054).

## Clarifications

### Session 2026-10-07

- Q: Which Redis client libraries does the agent capture in this feature? → A: All three - Lettuce, Jedis and Redisson.
- Q: Values are stored in full with no size limit; how is Redis storage kept bounded? → A: A total size cap for Redis data (default 2 GB); when full, the oldest calls' commands are dropped whole; session-cycle calls are never dropped; no value is ever shortened.
- Q: Which keys have their values masked by default? → A: None - nothing is masked until the user adds key patterns, like body redaction.
- Q: Where does endpoint health with Redis appear? → A: Claude/API only (`endpoint_health`, `POST /triage/endpoints`) - no new screen in ALFRED.
- Q: How are binary Java values decoded for display? → A: Safe structural read in ALFRED, on demand - class, field names and values read from the stored bytes without creating any object; nothing runs in the application (compared in `decoding-mock.html`). Kryo values with registered classes show values without names.

## Terms

- **⬢ switch** (⬢ Redis): the per-project on/off switch in the Sources bar, next to ● (call logging), ◆ (database capture) and ▤ (logs).
- **Command**: one Redis command the application sent during a call, with its arguments and the reply it got.
- **Hit / miss**: a read command that returned a value / returned nothing (nil, empty).
- **Failed command**: a command that got an error reply, timed out or lost its connection.
- **Key pattern**: a key with its variable parts replaced by `*` (e.g. `fare:rule:*`), used to group commands.
- **Spring Cache origin**: the cache name and method behind a command that was sent by Spring's caching support rather than by the code directly.
- **Writer**: the earlier recorded call whose command last wrote a key that this call read.
- **Store command**: the general record this feature introduces; Redis is its first store.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See a call's Redis commands (Priority: P1)

The user turns on ⬢ for odeysys, makes a request, and sees on the call card how many Redis commands the call sent, how many missed and failed. Opening it shows every command in order: what was sent, what came back, how long it took, and the line of code that sent it.

**Why this priority**: This is the feature. Everything else builds on having the commands recorded and linked to their call.

**Independent Test**: Turn ⬢ on, send one request that reads and writes Redis, open the call: the chip counts match and the Redis view lists each command with its full reply.

**Acceptance Scenarios**:

1. **Given** the agent is attached and ⬢ is on for odeysys, **When** a call sends 22 Redis commands of which 5 miss and 1 fails, **Then** the call card shows `⬢ Redis 22 · 5 miss · 1 failed` (in the failed colour) beside ◆ DB and ▤ Logs.
2. **Given** that call, **When** the user clicks the chip, **Then** the call's window opens on its **Redis** view listing all 22 commands in the order they were sent, each with number, command, key and arguments, reply, round-trip time and offset from the call's start.
3. **Given** the Redis view, **When** the user opens a command, **Then** it shows the full command, the full reply, value size, TTL, send time and round trip, the client and connection, database index, thread and code line - and the full value.
4. **Given** ⬢ is off for a project, **When** its calls are recorded, **Then** no Redis command is recorded and no ⬢ chip appears.
5. **Given** the agent is attached and ⬢ is on, **When** a call sends no Redis command, **Then** the card shows `⬢ Redis 0` in the muted style.
6. **Given** a call is still running, **When** its card is shown, **Then** the chip shows `live` and updates when the call ends - pushed, not polled.

---

### User Story 2 - Redis in the call's story (Priority: P1)

The user sees Redis commands in the same time order as statements, supplier calls and log lines, and on the timeline, so they can read cause and effect: "the cache missed, so the 738-row query ran, then the result was written back".

**Why this priority**: The value of linking is seeing Redis next to everything else the call did; without it Redis is just another list.

**Independent Test**: Open a call with statements, a supplier call, log lines and Redis commands; Together interleaves all four by order, and the timeline has a Redis lane.

**Acceptance Scenarios**:

1. **Given** a call with all four kinds of items, **When** the user opens **Together**, **Then** commands, statements, supplier calls and log lines appear in one list in the order they happened, numbered with one shared sequence.
2. **Given** the timeline, **When** it is shown, **Then** a **Redis** lane shows each command at its time; misses are drawn as an outline and failures in the failed colour; hovering shows the command, key, reply and time.
3. **Given** the window header, **When** a call has Redis commands, **Then** it shows the Redis count and total Redis time next to the database totals, and the summary line includes Redis time.
4. **Given** consecutive single reads of one key pattern from the same code line (e.g. 9 × `GET fare:rule:*`), **When** listed, **Then** they fold into one group row (`GET ×9 · n hit · m miss`) that opens to the single commands.
5. **Given** commands sent as one transaction (MULTI … EXEC), **When** listed, **Then** they fold into one transaction row showing the count, "1 round trip" and the EXEC result.

---

### User Story 3 - Find the problem fast (Priority: P1)

The user filters the call list to calls where a Redis command failed, and in a call sees findings that explain what went wrong with Redis and what to do.

**Why this priority**: Most visits start from "something is wrong"; failures and findings point straight at it.

**Independent Test**: Record a call whose script command fails and whose code reads 9 keys one by one; the stats bar counts it under Redis failures and Findings shows both problems with fixes.

**Acceptance Scenarios**:

1. **Given** recorded calls where some Redis commands failed, **When** the list is shown, **Then** the stats bar has a `✖ Redis failures` pill with the number of such calls; clicking it filters to them and combines with the status pills - a 200 that hid a failed command included.
2. **Given** the Redis view, **When** the user picks All / Reads / Writes / Misses / Failed or types in the search box, **Then** only matching commands remain (search covers command, key, arguments, value and Spring Cache name) and the footer says how many of how many are shown.
3. **Given** a call's commands, **When** Findings is opened, **Then** it lists, each with why and what to do and chips that jump to the commands: **Redis command failed**, **many reads one by one** (one batched read would do), **cache miss then the database**, **big value written**, **cache cold**, and a note when no dangerous whole-database command (KEYS, FLUSHDB, FLUSHALL, large SCAN loops) ran in the request.
4. **Given** a command slower than the project's slow threshold (default 10 ms), **When** shown, **Then** its time is highlighted and it is counted in Findings.

---

### User Story 4 - Understand the values (Priority: P2)

The user opens a cached value and reads it as the object it is, sees which Spring cache and method produced it, and - on a hit - which earlier call wrote it.

**Why this priority**: Java applications mostly store serialized or compressed binary values and use Spring Cache; without decoding and origin the raw data is unreadable and the question "where did this stale value come from?" stays open.

**Independent Test**: Open a hit on a JDK-serialized value written by an earlier recorded call: it shows the decoded object, the format, the cache name and method, and the writer call with a link.

**Acceptance Scenarios**:

1. **Given** a command sent through Spring Cache, **When** listed, **Then** its row has a CACHE (read) or PUT (write) tag, and its detail shows the cache name, the operation and the method with its argument.
2. **Given** a value in a known format (JDK serialization, Kryo, JSON, plain text, gzip- or Snappy-compressed), **When** opened, **Then** the detail shows the format (and class name when known), the decoded value by default, and a **Decoded / Raw bytes** switch. Sizes on the wire and unpacked are both shown for compressed values.
3. **Given** a value in an unknown format, **When** opened, **Then** the raw bytes are shown and the format says unknown - nothing is hidden.
4. **Given** a read that hit, **When** opened, **Then** a "Written by" line names the last recorded command that wrote that key - its call (method, path, status), how long before this call, a link to that call, and whether the value read is the same as the value written. When no recorded call wrote it, the line says so.
5. **Given** the **Keys** view, **When** shown, **Then** it lists one row per key pattern, slowest first, with commands, reads, writes, hit/miss bars, time, failures and "Last written by"; its header shows hits, misses and hit rate of reads.

---

### User Story 5 - See what a write replaced, and follow a value (Priority: P2)

The user turns on "value before a write" for a project to see what each write replaced, and clicks a value in a command to see everywhere else it appears in the call.

**Why this priority**: Explaining state changes and following an identifier through a call are frequent investigation steps, but each is optional for basic use.

**Independent Test**: With the option on, an INCR shows the old value; clicking a search id in a SET lists the supplier request body, other Redis commands and the response where it also appears.

**Acceptance Scenarios**:

1. **Given** "Value before a write" is on for the project, **When** a call writes a key (SET, INCR, MSET, HSET, DEL, EXPIRE, EVAL…), **Then** the command's detail shows what the key held before (value, nil/new key, or previous TTL).
2. **Given** the option is off (the default), **When** a call writes, **Then** no extra command is sent to Redis and the detail shows no "before" line.
3. **Given** an opened command with traceable values (ids, codes found in its key, arguments or value), **When** the user clicks one, **Then** the detail lists every other place in the call it appears: request, response, supplier calls (with the body path), database statements and rows, log lines and other Redis commands (with number and where in them).
4. **Given** any opened command, **When** the user clicks "Every call that used this key", **Then** they see the recorded calls that read or wrote that key.

---

### User Story 6 - Control capture per project (Priority: P2)

The user switches ⬢ on and off per project from the Sources bar and adjusts how Redis values are shown and masked from the project's ▾ menu.

**Why this priority**: Capture must be opt-in and controllable like ◆ and ▤; settings fine-tune it.

**Independent Test**: Click ⬢ off and on during traffic; only calls made while on have commands. Add `session:*` to masked keys; the window shows `‹masked · n B›` while the stored value is unchanged.

**Acceptance Scenarios**:

1. **Given** the Sources bar, **When** shown, **Then** each project pill has a ⬢ switch after ▤, lit when on, off by default, with a tooltip saying what it does.
2. **Given** a project's call logging (●) is off or no agent is attached, **When** the user looks at ⬢, **Then** it is shown blocked with the reason, as ◆ is.
3. **Given** the user clicks ⬢, **When** it changes, **Then** it takes effect for the next calls without restarting the application, the proxies or ALFRED.
4. **Given** the project's ▾ menu, **When** opened, **Then** a Redis section shows: capture on/off (same as ⬢), Redis clients found (name, version, connections, server and database), "Stored: every command and its full reply, as sent and received - always, no size limit", masked key patterns (empty by default), how to show values (decoded automatically / raw bytes - display only), Spring Cache names found, value before a write (off by default), slow command threshold, and whether to also record connection housekeeping (PING / AUTH / CLIENT / HELLO, off by default).
5. **Given** masked key patterns (e.g. `session:*, token:*`), **When** a matching command is shown in the window, an export or to Claude, **Then** its value is replaced by `‹masked · size›`; the stored data is not changed.

---

### User Story 7 - Redis in exports, imports, cycles and Claude (Priority: P2)

The user's exports, session cycles, imports and Claude's tools include the Redis commands of each call, complete.

**Why this priority**: These are how calls are shared and investigated beyond the window; Redis must travel with them like statements and log lines do.

**Independent Test**: Export a call with Redis commands as .json, re-import it, and see the same commands; ask Claude for problem calls and get the Redis failures.

**Acceptance Scenarios**:

1. **Given** a call with Redis commands, **When** exported as .md or .html, **Then** the call has a Redis section with every command and its full reply and value (masked keys masked); when exported as .json, the commands are included as their own records and re-importing gives back the same commands.
2. **Given** a call in a session cycle, **When** the cycle is kept, **Then** its Redis commands are kept with it, like its statements.
3. **Given** the Redis view, **When** the user clicks "Copy as redis-cli", **Then** the shown commands are copied as commands that can be pasted into redis-cli; "Export .redis" saves them as a file.
4. **Given** Claude's tools, **When** used, **Then** one call's Redis commands and an overview are available; problem calls, triage and investigate-call count a failed Redis command as a problem and "cache cold" as a warning; a key's history across calls is available; value tracing also searches Redis keys, arguments and replies; masked keys stay masked.

---

### User Story 8 - Redis across calls (Priority: P3)

The user sees Redis per endpoint and compares Redis behaviour between two cycles.

**Why this priority**: Useful for trends and regressions after the single-call view works.

**Independent Test**: Endpoint health shows Redis columns; comparing two cycles shows the change in Redis commands per call and hit rate.

**Acceptance Scenarios**:

1. **Given** Claude's endpoint health (the `endpoint_health` tool and `POST /triage/endpoints` - there is no endpoint health screen), **When** asked, **Then** each endpoint has Redis commands per call, hit rate (bar and %), misses followed by the database per call, and calls with failed commands.
2. **Given** two cycles, **When** compared, **Then** per endpoint the Redis commands per call, the change by command and key pattern, and the hit rate before and after are shown.

---

### Edge Cases

- **Asynchronous client**: replies that arrive on another thread (e.g. Lettuce/Netty) are still attributed to the call that sent the command; commands the call sends from its own worker threads are attributed to it.
- **Commands outside any call** (scheduled jobs, start-up warm-up, other users of the same Redis): not recorded.
- **Pipelines and transactions**: each command is recorded with its own reply; a transaction's queued replies and the EXEC result are both kept; the group shows one round trip.
- **Pub/sub**: a PUBLISH sent by the call is recorded with its subscriber count; messages the application receives as a subscriber are not.
- **Blocking commands** (BLPOP, XREAD BLOCK…): recorded with their full wait as their time.
- **Scripts**: EVAL/EVALSHA script text, keys, arguments and reply are recorded; changes the script makes inside Redis are not visible.
- **Huge values**: stored in full, whatever their size; the window shows them in a scrollable box.
- **Binary values that cannot be decoded**: shown as raw bytes; a value whose structure is only partly readable shows the readable part with the rest as bytes.
- **Connection lost / timeout mid-command**: recorded as a failed command with what happened.
- **Several Redis servers or databases in one call**: each command shows its server and database.
- **Agent detached or ⬢ turned off while a call runs**: the call keeps what was recorded and shows "capture ended early", as statements do.
- **Key never written by a recorded call**: "Written by" says so instead of guessing.
- **Value before a write on a key that does not exist**: shown as "(nil) - new key".
- **Masked key in a trace**: the trace shows where the masked value appears but not the value.
- **Commands with secrets in arguments** (AUTH): not recorded by default; if housekeeping recording is turned on, AUTH arguments are still never stored.

## Requirements *(mandatory)*

### Functional Requirements

**Capture**

- **FR-001**: The agent MUST record every Redis command the application sends while serving a recorded inbound call of a project with ⬢ on, for the Lettuce, Jedis and Redisson clients and anything built on them (Spring Data Redis, Spring Cache).
- **FR-002**: Recording MUST follow the same opt-in rules as database capture: only for calls the reverse proxy marks for Redis capture, which it does only when the project's call logging is on and its ⬢ is on.
- **FR-003**: The agent MUST NOT change what the application sends or receives, and MUST NOT send any command of its own, except the opt-in "value before a write" read (FR-024).
- **FR-004**: Each command MUST be recorded with: its order number in the call's shared sequence (shared with statements and supplier calls), the command and all its arguments, its reply (or error), the reply's type, the key(s), sizes sent and received, the time it was sent, its round-trip time, the client (name, version), connection, server, database index, thread, and the code line that sent it.
- **FR-005**: A command whose reply arrives on a different thread than the one that sent it MUST be attributed to the call that sent it; commands a call sends from threads it started MUST be attributed to that call.
- **FR-006**: Pipelined and transaction (MULTI … EXEC) commands MUST be recorded individually and marked as belonging to their pipeline or transaction.
- **FR-007**: Connection housekeeping commands (PING, AUTH, CLIENT, HELLO, SELECT on connect) MUST NOT be recorded unless the project's setting turns them on; AUTH and HELLO credentials MUST never be stored.
- **FR-008**: Recorded commands MUST travel to ALFRED with the call's database statements and be stored with them; a lost connection to ALFRED MUST NOT block or slow the application.

**Switch and settings**

- **FR-010**: Each project pill in the Sources bar (Live calls and Session cycles) MUST have a ⬢ switch after ▤ that turns Redis capture on and off live, off by default, blocked with a reason while call logging is off or no agent is attached.
- **FR-011**: The project's ▾ menu MUST have a Redis section matching the mock: capture on/off, clients found, the "stored in full, always" statement, masked key patterns, show values as (decoded automatically / raw bytes), Spring Cache names found, value before a write (off), slow command threshold (default 10 ms), record housekeeping commands (off).
- **FR-012**: There MUST be no setting that limits what is stored (no "keys only", no size cap, no hashing of large values).

**Call list**

- **FR-013**: A call card MUST show a ⬢ Redis chip next to the ▤ Logs chip: count, misses, failures, total time when nothing missed or failed, `live` while running, `capture ended early` when applicable, muted `⬢ Redis 0` when the agent saw no command, and no chip when ⬢ was off. A failure turns the chip to the failed style. Clicking it opens the call's window on the Redis view.
- **FR-014**: Chip counts MUST be fetched only for cards on screen, batched, and refreshed on change notifications - never by polling.
- **FR-015**: The stats bar MUST have a `✖ Redis failures` pill counting calls with at least one failed command, filtering on click and combining with the status pills.

**Call window**

- **FR-016**: The window header MUST show the Redis command count and total Redis time; the summary line MUST include Redis time; the timeline legend MUST show the Redis connections, pool wait and commands vs round trips.
- **FR-017**: The timeline MUST have a Redis lane (strip and detailed layouts): each command at its time and length, misses as an outline, failures in the failed colour, hover showing number, command, key, reply and time, click opening it in the list.
- **FR-018**: The window MUST have a **Redis** view (count in its tab) with All / Reads / Writes / Misses / Failed filters and search; each row shows number, command (read / write / failed colours), Spring Cache tag, key and arguments, reply (hit green, miss amber, error red), time (slow highlighted) and offset. The footer shows "Showing n of m Redis commands" and offers "Copy as redis-cli" and "Export .redis".
- **FR-019**: Consecutive single reads of the same key pattern from the same code line MUST fold into one group row with count, hits, misses, total time and the batching warning; transactions MUST fold into one transaction row; both open to their commands.
- **FR-020**: An opened command MUST show the full command, reply, Spring Cache origin, value format, value size, TTL, value before the write (when recorded), send time and round trip (noting one round trip for a transaction), client, connection, pool wait, server and database, thread, code line, "Written by" (for hits), the value with Decoded / Raw bytes when decodable, traceable values, "Copy as redis-cli", "Every call that used this key", and tags for slow commands and grouped reads.
- **FR-021**: **Together** MUST include Redis commands and groups among statements, supplier calls and log lines in shared sequence order; its count and footer MUST include Redis.
- **FR-022**: The window MUST have a **Keys** view: one row per key pattern with commands, reads, writes, hit/miss, time, failures and last writer; header with hits, misses and hit rate of reads.
- **FR-023**: Values MUST be decoded for display by ALFRED, only when a value is shown, by reading the stored bytes as a structure - never by creating objects from them and never inside the application. Recognised formats: JDK serialization (class name, field names, values; common JDK types such as strings, numbers, BigDecimal, lists, maps and dates shown as values), Kryo (values; class and field names only where the bytes carry them, otherwise numbered), JSON, plain text, gzip, Snappy, and the formats Spring Data Redis serializers produce. Anything else, and any part that cannot be read (e.g. custom-written fields), is shown as raw bytes. Decoding adds nothing to the application's work; it never changes what is stored (FR-054).
- **FR-024**: When "value before a write" is on for the project, the agent MUST read the key's prior value (or TTL for TTL commands) just before each write and record it with the command; when off, no extra command is sent.
- **FR-025**: For each read that returns a value, ALFRED MUST find the last recorded command that wrote that key before it (in any recorded call of the project) and show its call, how long before, and whether the values match; when none exists it MUST say so.
- **FR-026**: Values in keys, arguments and replies MUST be traceable within the call, listing every other occurrence in the request, response, supplier calls, statements and rows, log lines and Redis commands; "Every call that used this key" MUST list the recorded calls that read or wrote it.

**Findings**

- **FR-027**: Findings MUST include, each with why, what to do and chips to the commands: Redis command failed (with the related log line when there is one); many single reads of one pattern from one code line; a miss followed by the database query that fills it; a big value written; cache cold (misses on keys a recorded call wrote earlier that have since expired); and a note confirming no KEYS / FLUSHDB / FLUSHALL / large SCAN loop ran (or a warning when one did).

**Exports, storage, Claude**

- **FR-030**: .md and .html exports MUST include a Redis section per call with every command, reply and value in full (masked keys masked); the .json export MUST include the commands as records and its importer MUST read them back unchanged. Nothing may be truncated or summarised.
- **FR-031**: Redis commands MUST be kept with session-cycle calls and imported calls the same way statements are.
- **FR-032**: Masked key patterns default to none. They MUST mask values (as `‹masked · size›`) everywhere they are shown - window, exports, Claude - and MUST NOT change stored data.
- **FR-033**: Claude's tools MUST offer one call's Redis commands and an overview, a key's history across calls, and MUST include Redis in problem calls, triage, investigate call, value tracing, endpoint health and cycle comparison.
- **FR-034**: Endpoint health (Claude's `endpoint_health` tool and its API; no ALFRED screen) MUST show per endpoint Redis commands per call, hit rate, misses followed by the database per call, and calls with failed commands; cycle comparison MUST show the change in Redis commands per call by command and key pattern and the hit rate before and after.
- **FR-035**: Commands MUST be stored as general store commands (with the store named), so that other stores (e.g. Kafka, MongoDB, Memcached) can reuse the same chip, lane, view, findings, exports and tools later. Only Redis is captured in this feature.
- **FR-036**: Stored Redis data MUST be kept under a total size cap (default 2 GB, configurable): when a new call's commands would exceed it, the commands of the oldest calls are removed whole (a call never keeps part of its commands) until it fits. Commands of session-cycle and imported calls are never removed by the cap. No value is ever shortened to save space. Commands are also removed when their call is deleted.

**Ready for a later Relive (not built here)**

- **FR-050**: Each command's arguments and reply MUST be stored byte for byte, whatever their size, with the reply's exact type (text, integer, nil, empty, list, map, set, error, …), so a reply can later be given back to the application without Redis.
- **FR-051**: Each command MUST carry a stable identity within its call (its sequence number) and a fingerprint (command + key pattern + argument shape) for matching a later request to a recorded one.
- **FR-052**: The agent's per-client recording point MUST be the place where a later version can return a supplied reply instead of sending the command; this feature only records there.
- **FR-053**: The run tag ALFRED puts on Relive traffic MUST be recorded on each command, as it is on statements.
- **FR-054**: Masking, decoding and display options MUST apply only to what is shown, never to what is stored.

### Key Entities

- **Store command**: one command a call sent to a store. Store (redis), call, sequence number, command name, key(s), arguments (raw bytes), reply (raw bytes) and reply type, error, sizes, sent time, round trip, client, connection, server, database, thread, code line, Spring Cache origin (cache, operation, method), pipeline/transaction group, value before the write (when recorded), fingerprint, run tag.
- **Key pattern**: a key with variable parts as `*`; groups commands in the Keys view, findings, endpoint health and comparisons.
- **Key writer link**: for a read, the last recorded write of the same key before it - its command and call - and whether the values match.
- **Project Redis settings**: ⬢ on/off, masked key patterns, show values as, value before a write, slow threshold, record housekeeping commands; plus what was detected (clients, connections, servers, Spring Cache names).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With ⬢ on, 100% of the Redis commands a recorded call sends (across the three supported clients, synchronous, asynchronous, pipelined and in transactions) appear in that call's Redis view, in the order sent, with the same reply the application received.
- **SC-002**: Turning ⬢ on or off takes effect for the next call within 2 seconds, with no restart of anything.
- **SC-003**: Recording adds no more than 5% to a call's total time and no more than 0.2 ms per command, measured on a call with 100 commands.
- **SC-004**: A user can go from "a call returned wrong data" to the Redis command that caused it (failed, missed, or stale value with its writer) in under 1 minute, using the chip, Findings and "Written by".
- **SC-005**: A 1.8 MB value and a binary value are stored and exported byte-for-byte identical to what the application sent and received (verified by comparing bytes), and re-importing an exported .json gives back identical commands.
- **SC-006**: Values in the three most common Java formats (JDK serialization, JSON, gzip-compressed JSON) are shown decoded without any setting.
- **SC-009**: With the size cap reached, recording continues without failing and stored Redis data stays within 2 GB plus one call's worth; session-cycle calls keep all their commands.
- **SC-007**: With ⬢ off, no Redis command of that project is stored and the application's behaviour and timing are unchanged.
- **SC-008**: The window, chip, lane, filters, Findings, Keys view and settings match `specs/011-redis-capture/mock.html` in layout, wording and colours. Two exceptions: the masked-keys field starts empty (the mock's `session:*, token:*` is an example a user typed), and mock section 7's endpoint table illustrates what Claude's `endpoint_health` returns - it is not a screen.

## Assumptions

- The application runs on a JVM with the ALFRED agent attached (as for database capture); applications without the agent get no Redis capture.
- Lettuce, Jedis and Redisson are all captured in this feature; Spring Data Redis and Spring Cache sit on one of them. odeysys uses Lettuce through Spring Data Redis (as in the mock).
- Redis commands are stored next to the call's database statements, bounded by their own size cap (FR-036), the same approach outbound calls use.
- "Value before a write" is the only case where the agent sends its own command, mirroring the opt-in database before-image read; it is off by default.
- Decoding binary values is for display only and best-effort, done in ALFRED; an unknown format falls back to raw bytes. Values of Kryo-registered classes are shown without field names (accepted trade-off - the application is never asked to decode).
- The "Written by" lookup only finds writes that ALFRED recorded; writes by other systems, scheduled jobs or before capture started are reported as "no recorded writer".
- Masking uses key patterns and defaults to none, like redaction of bodies; the user adds patterns such as `session:*` in the Redis settings.
- Kafka, MongoDB, Memcached capture and Relive replay of Redis are out of scope; only the shared model and the replay seams (FR-035, FR-050 to FR-054) are part of this feature.
- The colour for Redis is coral (`#ff7a59` dark / `#c2410c` light) and the glyph is ⬢, as in the mock.
