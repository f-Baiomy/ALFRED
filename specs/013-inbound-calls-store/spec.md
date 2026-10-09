# Feature Specification: Inbound calls that survive a busy backend

**Feature Branch**: `013-inbound-calls-store`
**Created**: 2026-10-09
**Status**: Draft
**Input**: User description: "do 1,2 and for 3 and for memory i want to raise the heap share .. then apply the longerterm"

## Background

On 2026-10-09 three inbound calls were found stored with only their response - no address, method, time or project.
One of them made every log search fail. The cause was measured on the running Docker install:

- The reverse proxy reports each inbound call to Alfred twice: once when the request arrives ("prepare") and once when
  the response comes back ("complete"). Each report gives up after 2 seconds. When Alfred stalls longer than that, the
  first report can arrive after the second, or not at all.
- Alfred stalls because it keeps every retained inbound call in memory. With the owner's retention of 7,000 calls
  (about 67 KB each, a 467 MB file) the live memory after a full clean-up is 835 MB of a 1 GB limit, leaving 15 %
  headroom; five full clean-ups ran in twenty quiet minutes.
- Every 3,500 calls Alfred rewrites the whole inbound file while every other inbound report waits. On the Docker
  Desktop folder mount, only copying that file takes 6.7 seconds - each rewrite is a guaranteed 2-second timeout.
- The proxy's "report failed" lines were held back in a buffer and only appeared when the proxy restarted, so the
  failures were invisible when they happened.

Commit 326ac85b already makes a call whose first report is late or lost still be stored as that call. This feature
removes the reasons the reports are late in the first place.

## Clarifications

### Session 2026-10-09

- Q: How are old inbound calls removed once they live in a database? → A: Keep the count (owner setting, 7,000 here) and add a total-size safety cap (default 10 GB, as outbound has); the oldest calls go when either limit is reached.
- Q: What does the proxy do when a report still fails after waiting? → A: Retry the same report up to 3 times with growing gaps (about 2 s, 5 s, 10 s), keeping prepare before complete, then log it as failed.
- Q: Which calls from the old file are moved into the database on first start? → A: Only the retained ones (the newest, up to the retention count) - exactly what the live list shows; the old file is kept, renamed.
- Q: How big is the backend's memory share in Docker? → A: 75 % of the unchanged 2 GB container (1.5 GB). (Planning found the native install already runs a 2 GB heap by default, so it needs no change.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A slow moment never loses or damages a call (Priority: P1)

A developer works through their application while Alfred logs every inbound call. Alfred is briefly busy (a memory
clean-up, a large write, a machine waking from sleep). Every call made during that moment still appears in the live
list complete - address, method, time, project, request and response - just possibly a few seconds later.

**Why this priority**: A logged call that is missing or half-empty is the core failure; everything else (search,
triage, exports, Relive) depends on calls being complete.

**Independent Test**: Make Alfred stall for 10 seconds while calls flow through the reverse proxy; afterwards every
call is in the list, complete, and none were reported as failed.

**Acceptance Scenarios**:

1. **Given** Alfred stops answering for up to 10 seconds, **When** calls pass through the reverse proxy during that
   time, **Then** each is stored complete once Alfred answers again, and the proxy reports no failure for them.
2. **Given** calls pass through the reverse proxy, **When** they reach the application, **Then** they are not slowed
   by Alfred's stall - only the moment they appear in the list is delayed.

---

### User Story 2 - A failed report is visible when it happens (Priority: P1)

When the reverse proxy cannot report a call to Alfred, the owner sees that in the proxy's log right away, with the
reason (timed out, refused, the answer Alfred gave), not only after the proxy restarts.

**Why this priority**: Without it the next incident is as hard to diagnose as this one was; it is also small.

**Independent Test**: Stop Alfred's backend, send one call through the reverse proxy, read the proxy's log within
seconds: the failed report is there with its reason.

**Acceptance Scenarios**:

1. **Given** Alfred's backend is down, **When** a call passes through the reverse proxy, **Then** a line naming the
   call and the reason appears in the proxy's log within 5 seconds.
2. **Given** the forward (outbound) proxy fails to report a call, **Then** the same holds for it.

---

### User Story 3 - Alfred has room to work (Priority: P2)

With the owner's chosen retention, Alfred keeps enough free memory that clean-ups are short and rare, until the
database store (Story 4) removes the in-memory window altogether.

**Why this priority**: It lowers the stall rate immediately, with no data changes, while Story 4 is built.

**Independent Test**: With 7,000 retained inbound calls, the free memory after a full clean-up is at least 40 % of
Alfred's limit, on Docker and on the native install.

**Acceptance Scenarios**:

1. **Given** the Docker install with its 2 GB container, **When** Alfred starts, **Then** its memory limit is a larger
   share of the container than today's half, still leaving the container enough for everything outside it.
2. **Given** the native install, **Then** its default memory setting gives at least the same headroom (it already
   does: a 2 GB heap), and the owner can still change it.

---

### User Story 4 - Inbound calls live in a database, like outbound calls (Priority: P2)

Inbound calls are stored in a database instead of a file held whole in memory. Memory use no longer grows with how
many calls are kept, keeping more calls never makes Alfred stall, and nothing rewrites all of them at once.

**Why this priority**: It removes both measured causes for good; it is larger and builds on Stories 1-3 being in
place.

**Independent Test**: Keep 20,000 inbound calls; Alfred's memory stays flat as calls are added, every inbound report
is answered in under 1 second throughout, and the live list, search, triage, cycles and exports behave as before.

**Acceptance Scenarios**:

1. **Given** an install that has inbound calls in the old file, **When** Alfred starts with the new store for the
   first time, **Then** every call still within retention is moved over once, in order, nothing lost or duplicated,
   and the old file is kept aside, not deleted.
2. **Given** the retention limit is reached, **When** a new inbound call arrives, **Then** the oldest calls are removed
   a few at a time, never by rewriting everything, and no report waits on it.
3. **Given** an owner who sets the inbound store back to the file, **Then** Alfred works as it does today.
4. **Given** the new store, **Then** everything that reads inbound calls today - the live list and its filters, call
   detail, search, triage, log and database links, session-cycle capture, Relive (including deleting a run's calls),
   WebSocket messages, baselines, exports, resend - returns the same answers as with the file.

### Edge Cases

- Alfred is down for longer than the proxy's wait plus its 3 retries (about 77 s in all: 4 x 15 s + 2 + 5 + 10 s): each report given up is
  logged (Story 2) and the call is stored from whatever report gets through (commit 326ac85b).
- Retries delay the reports queued behind them, never the proxied traffic; a long outage delays the live list, it does
  not lose order.
- A first report arrives after its completion: merged into the stored call (commit 326ac85b) - must keep working with
  the new store.
- Moving the old file over is interrupted (Alfred stopped half way): the next start finishes it without duplicates.
- The old file has malformed lines, lines without an id, or calls deleted by a Relive run delete: handled the same way
  the file reader handles them today.
- A burst of hundreds of calls at once: no report is lost and none waits more than the proxy's limit.
- The disk is full: Alfred says so and keeps serving reads; no silent loss.
- Session-cycle copies of inbound calls are separate today and stay unchanged.

## Requirements *(mandatory)*

### Functional Requirements

**Reporting (Stories 1-2)**

- **FR-001**: The reverse and forward proxies MUST wait at least 15 seconds for Alfred to accept a report (today 2
  seconds), configurable as today. A report that still fails MUST be retried up to 3 times with growing gaps (about
  2 s, 5 s, 10 s) before it counts as failed; a call's first report MUST always be delivered or given up before its
  completion is sent. The one report sent while a request waits (a Relive step's first report) is tried once on the
  request path and, if that fails, handed to the background sender for its retries - so the request never waits for
  a retry.
- **FR-002**: Waiting on a report MUST never delay the proxied request or response itself.
- **FR-003**: Every failed attempt and every report given up MUST appear in the proxy's log immediately, naming the
  call, the kind of report, the attempt and the reason (timed out, connection refused, the status Alfred answered).

**Memory (Story 3)**

- **FR-004**: The Docker install MUST give Alfred's backend 75 % of its container's memory (1.5 GB of the unchanged
  2 GB limit; today 50 %).
- **FR-005**: The native install MUST keep at least the same headroom: its backend already starts with a 2 GB heap
  by default (`ALFRED_MEMORY`), above the 1.5 GB target, so the default stays; an owner's own setting still wins.

**Inbound store (Story 4)**

- **FR-006**: Inbound calls MUST be stored in a database by default, the way outbound calls already are, with the
  current file store kept as a selectable fallback.
- **FR-007**: Memory use for inbound calls MUST NOT grow with the number of retained calls.
- **FR-008**: The owner's existing inbound retention setting (number of calls) MUST keep its meaning, and a total-size
  cap MUST be added (default 10 GB, configurable like outbound's); the oldest calls are removed when either limit is
  reached. Removing old calls MUST happen in small steps that never block storing a new one.
- **FR-009**: On the first start with the database store, the retained inbound calls in the old file (the newest, up
  to the retention count - what the live list shows) MUST be moved over exactly once, in order; older lines still in
  the file are not moved. The old file MUST be kept, renamed, never deleted.
- **FR-010**: Every feature that reads or changes inbound calls today MUST give the same results with either store
  (list, filters, pagination, detail, search, status breakdown, baseline, recent request headers, WebSocket messages,
  Relive run lookups and deletes, session-cycle capture, exports, investigation tools, triage).
- **FR-011**: A first report arriving after its completion MUST still be merged into the stored call, and a completion
  without a first report MUST still be stored as that call (behaviour of commit 326ac85b).
- **FR-012**: The native install and the Docker install MUST both use the new store, with their data in each install's
  existing data location.
- **FR-013**: Exports and imports MUST be unaffected: never truncated, same format.
- **FR-014**: When Alfred cannot store a call (disk full, database error) it MUST log an error, answer the report with
  a server error so the proxy retries it, and keep serving reads - never accept a report and silently drop it.
- **FR-015**: The call identity a completion carries MUST be bounded (address at most 8 KB, method at most 16
  characters); a report exceeding it is refused with a client error, like any other invalid report.

### Key Entities

- **Inbound call**: one request into a project Alfred fronts and its outcome - id, project, address as called and as
  forwarded, method, time, request and response (headers and body), duration, state, session and operation ids,
  interception record, resend origin, Relive attribution, WebSocket messages.
- **Retention**: how many inbound calls are kept (owner setting, today 7,000 on this install, 1,500 by default), plus
  a total-size cap (10 GB by default); whichever is reached first removes the oldest calls.
- **Report** (a webhook): what the reverse proxy sends Alfred about a call - the first ("prepare") when the request
  arrives, the second ("complete") when it completes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With Alfred made to stall for 10 seconds, or restarted (back within 30 seconds), under steady traffic, 100 % of calls are stored complete and the
  proxy logs zero failed reports.
- **SC-002**: A failed report appears in the proxy's log within 5 seconds of happening.
- **SC-003**: After Story 3, free memory after a full clean-up is at least 40 % of the backend's limit with 7,000
  retained inbound calls (today 15 %).
- **SC-004**: After Story 4, the backend's memory in use stays within 10 % whether it retains 1,500 or 20,000 inbound
  calls.
- **SC-005**: After Story 4, every inbound report is answered in under 1 second, including while old calls are being
  removed; no step ever rewrites all retained calls.
- **SC-006**: After Story 4, moving an existing 7,000-call file over takes under 5 minutes and loses or duplicates no
  call.
- **SC-007**: The existing automated tests for inbound calls pass against both stores.

## Assumptions

- The owner keeps retention at 7,000 calls; nothing in this feature lowers it.
- The Docker container limit stays 2 GB; only the backend's share inside it changes (to 75 %), leaving 512 MB for
  everything outside the heap.
- The database is the same kind outbound calls already use, one file per install in the existing data location.
- Session-cycle copies of inbound calls are out of scope; they are stored separately and are bounded by design.
- The forward proxy gets the same reporting changes (FR-001, FR-003) since it shares the reporting code's shape.
- Stories 1-3 ship first and independently; Story 4 follows on the same branch.
- Rows already stored with only a response (three today) are left as they are.
