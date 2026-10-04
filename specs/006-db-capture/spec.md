# Feature Specification: Database Capture

**Feature Branch**: `006-db-capture`
**Created**: 2026-10-04
**Status**: Draft
**Input**: User description: "Capture the database statements a Java app runs for each inbound call, show them linked to that call, and let Relive replay them without touching the real database"
**UI mock (approval gate)**: [mock.html](mock.html) - the agreed design; this spec describes what it shows.

## Overview

ALFRED already records every HTTP call around an application: the inbound calls into it and the outbound
calls it makes to suppliers. It can show a recorded call, resend it, and replay a whole recorded workflow
(Relive Cycle) with suppliers answered from the recording.

What ALFRED cannot see today is the application's own database work. That leaves two gaps:

1. **Debugging is half-blind.** When a past call behaved strangely, the user sees what came in and what went to
   suppliers, but not what the code read from or wrote to its database in between - the data the code
   actually made its decisions on.
2. **Replay is not safe.** Replaying a recorded call re-runs the application's real database writes. Replaying a
   "pay" call ten times debits the wallet ten times. Only HTTP can be answered from the recording today.

**Database Capture** closes both gaps. A small add-on attached to the running application (with no change to
the application's code) records every database statement the application runs - the statement, its values,
what came back, how long it took - tied exactly to the inbound call that caused it and in the exact order it
ran relative to that call's supplier calls. ALFRED shows this per call, helps the user investigate it, and
lets Relive answer database statements from the recording so a replay never touches the real data.

**Scope of this feature**: capture, attribution, viewing and investigation (Stories 1-4). Replaying statements
through Relive (Stories 5-7) is a **later feature**. It is described here so this feature's captured data and
capture add-on are built to support it without rework (FR-040 to FR-043); it is not built or tested here.

Terminology used below:

- **Statement**: one database operation the application ran (a read, an insert, an update, a delete, a stored
  procedure call, a commit or rollback), with its values and its result.
- **Capture add-on** (called "the agent" in the plan and tasks): the component attached to the running
  application that observes its database work and sends it to ALFRED. It is the only new thing that runs inside
  the user's application.
- **Before-image**: a copy of the rows an update or delete is about to change, read just before it runs. Off
  by default; turned on per table.
- **REPLAY / LIVE**: as in Relive - REPLAY means ALFRED answers in place of the real system; LIVE means the real
  system is used.

## Clarifications

### Session 2026-10-04 (design review with the owner, recorded from the mock iterations)

- Q: How is the database work observed - by sitting on the network between the application and the database,
  or from inside the application? → A: From inside the application, by an add-on attached at startup or
  to the already-running process. It works the same for every relational database the application uses
  (including vendors whose network protocol is closed), and it knows exactly which inbound call each
  statement belongs to even under concurrent traffic. A network-level capture remains a possible later
  addition for non-Java applications, behind the same stored format.
- Q: How should statements appear on the Live Calls page, given calls can run hundreds of them? → A: Not in the
  call list. Each call gets a single summary chip; clicking it opens a separate window where every statement
  is one collapsed line that expands on click.
- Q: How are transactions and repeated queries shown? → A: As tree nodes: a transaction (or a run of the same
  query) is one parent line with its statements hanging under it, foldable.
- Q: Should statement text show placeholders or real values? → A: Real values filled in by default, with a
  switch back to placeholders. Copying gives the filled-in statement.
- Q: Large results? → A: All rows are stored (up to a per-result limit); the result is shown in a fixed-height
  table that loads more rows as the user scrolls.
- Q: Can the user filter results and statements? → A: Yes - a quick text search, column sorting, and a SQL
  query box over the recorded data (a result's rows, or the call's statements). Queries never run against the
  real database.
- Q: A delete only reports how many rows it removed. How are deleted rows shown? → A: From an earlier read of the
  same rows in the same call when there is one; otherwise from a before-image when the user has turned it on
  for that table; otherwise the window says plainly that the contents were not captured and offers to turn
  before-image on. The same applies to updates with no earlier read.
- Q: Where is capture switched on? → A: Per project, in the same places as inbound logging: the Live Calls
  Sources bar, the Session Cycles widget's Sources panel, and the Settings page - one setting shown in three
  places.

### Session 2026-10-04 (clarify)

- Q: Is Relive replay of database statements part of this feature? → A: No. This feature is database capture
  only (Stories 1-4). Relive integration (Stories 5-7, FR-030 to FR-037) is a later feature; this feature must
  store and capture what it will need (FR-040 to FR-043) so it can be added without re-capturing or redesign.
- Q: Which stories does this feature build? → A: All four in-scope stories - Stories 1-2 first (capture, attribution,
  window, switches), then Stories 3-4 (investigation tools, delete and update details).
- Q: Which databases get vendor-specific handling? → A: Oracle, PostgreSQL, MySQL/MariaDB and SQL Server - all four
  are supported from the start, including their vendor-specific value types and error codes.
- Q: Oldest Java version the capture add-on must run on? → A: Java 8 (and every newer version).
- Q: What is captured from returned rows by default? → A: All of it - every row and every value, nothing hidden by
  default (it is the owner's own database). Values are hidden only where the user has set up a redaction rule.
- Q: How many rows are stored per statement result? → A: 50,000 by default, changeable in Settings; the true total
  count is always kept.
- Q (from /speckit.analyze): Do redaction rules hide database values in the window? → A: No. As everywhere in
  ALFRED, redaction rules apply to exports only; the window always shows every value. A new rule kind lets the
  user hide a database column (and the parameters bound to it) in exports.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See what the code did in its database for a call (Priority: P1)

A developer opens a recorded inbound call - for example a payment that returned 200 but left the wallet in a
strange state. Next to the call they see a summary: how many statements ran, how many were writes, whether any
failed. They open the database window and read, in the order things happened, every statement the code ran
for that call, interleaved with the supplier calls it made. Each line expands to show the statement with its
real values, the parameters, the rows that came back (or how many were changed), how long it took, and where in
the code it was called from.

**Why this priority**: This is the core value and needs nothing else. It turns "what did the code see?" from
guesswork into a direct read, and it is the foundation every other story builds on.

**Independent Test**: Attach the add-on to an application, make one inbound call that reads and writes data
and calls a supplier, then open that call in ALFRED and confirm every statement is listed in run order with
its values, results and timing, and the supplier call sits between the right statements.

**Acceptance Scenarios**:

1. **Given** capture is on for a project and the add-on is attached, **When** an inbound call runs 6 statements
   and 2 supplier calls, **Then** the call shows a database summary chip with "6 statements" and the database
   window lists all 6 statements and both supplier calls in the exact order they happened.
2. **Given** 50 inbound calls run at the same time, **When** each is opened, **Then** each shows only its own
   statements - none is missing and none belongs to another call.
3. **Given** a statement's line in the window, **When** the user expands it, **Then** they see the statement with
   values filled in (switchable to placeholders), the parameters with their types, the returned rows or the
   number of rows changed, generated keys, duration, thread and calling code location.
4. **Given** statements that ran inside a transaction, **When** the window opens, **Then** they appear under one
   transaction line that says whether it committed or rolled back and how long it was held.
5. **Given** a statement failed, **When** the window opens, **Then** that line is marked failed and shows the
   database error (message and codes), and if the call still succeeded the window says the error was
   swallowed.
6. **Given** a transaction rolled back, **When** the window opens, **Then** its statements are struck through
   and labelled as not saved.
7. **Given** a call ran no statements, **When** it is listed, **Then** its chip shows zero, which is visibly
   different from a call whose statements were not captured.
8. **Given** a call is still in progress, **When** its window is open, **Then** new statements appear as they run,
   without the user refreshing.

---

### User Story 2 - Switch capture on and off per project (Priority: P1)

A developer turns database capture on for one project and leaves it off for another, from wherever they are
working: the Live Calls Sources bar, the Session Cycles widget, or Settings. They can see whether the add-on is
attached to that project's application.

**Why this priority**: Without control over where capture runs, Story 1 cannot be used safely on a shared
ALFRED. It ships together with Story 1.

**Independent Test**: Toggle capture for a project in one of the three places and confirm the other two
update at once, that calls made afterwards are captured, and that calls made while it was off are not.

**Acceptance Scenarios**:

1. **Given** the Live Calls Sources bar, **When** the user clicks a project's database switch, **Then** capture
   turns on or off for that project, and the Session Cycles widget and Settings show the new state without a
   reload.
2. **Given** inbound logging is off for a project, **When** the user looks at its database switch, **Then** the
   switch is unavailable and explains that statements need inbound calls to attach to.
3. **Given** the add-on is not attached to a project's application, **When** the user looks at that project,
   **Then** ALFRED says so and shows how to attach it; calls look exactly as they do today.
4. **Given** capture is turned on, **When** the setting changes, **Then** it applies to every user and every
   session cycle, live.

---

### User Story 3 - Find the problem quickly in a busy call (Priority: P2)

A call ran 200 statements. The developer does not want to read them all. ALFRED flags the likely problems at
the top of the window - a failed and swallowed statement, a rollback, a delete or update with no condition,
the same query repeated many times, a slow statement, a huge result, a lock held across a supplier call - and
each flag jumps to the statement. A time strip shows where the call's time went (database, suppliers, the
application itself). The developer can search, filter to reads, writes, deletes or failures, see a per-table
summary, click any value to trace everywhere it appears in the call (statements, rows, supplier requests and
responses), and query the statements or a result's rows with SQL.

**Why this priority**: Story 1 makes the data visible; this story makes it usable at real volumes. It is the
difference between "the data is there" and "I found the bug in a minute".

**Independent Test**: Record a call containing a failed statement, a 12-times repeated query and a 2,000-row
result; confirm each produces a flag, each flag opens the right statement, and a SQL query over the
statements returns the expected subset.

**Acceptance Scenarios**:

1. **Given** a call with problems of the kinds above, **When** the window opens, **Then** each problem appears as
   a flag, and clicking it opens and scrolls to the statement or group concerned.
2. **Given** the user clicks a value such as a payment reference, **When** tracing starts, **Then** every place the
   value appears is highlighted and listed in run order, including inside supplier request and response
   bodies, and each place can be jumped to.
3. **Given** the Tables view, **When** it opens, **Then** it lists each table the call touched with its reads,
   inserts, updates, deleted rows, failures and time, and clicking a table filters the statements to it.
4. **Given** a result of 2,431 rows, **When** the user opens it, **Then** it is shown in a fixed-height table with a
   fixed header that loads more rows as the user scrolls, and states how many rows exist in total.
5. **Given** a result, **When** the user types in its search box or writes a query such as "rows where amount >
   500, grouped by kind", **Then** only matching rows (or the grouped result) are shown, with a plain error for a
   query that cannot be read.
6. **Given** the statement list, **When** the user writes a query such as "statements slower than 5 ms, slowest
   first", **Then** only those statements are shown; a summary query (counts per table) shows a summary table.
7. **Given** any statement, **When** it is shown in the window or traced, **Then** every value is shown in full.
   **Given** the user has added a redaction rule for a database column (for example `card_token`), **When** the call
   is exported, **Then** that column's values and the parameters bound to it are masked in the export, and the
   export states how many values were masked.

---

### User Story 4 - Know what a delete or update removed or changed (Priority: P2)

A developer sees "3 rows deleted" and needs to know which 3. ALFRED shows the deleted rows when it has them -
from an earlier read of the same rows in the call, or from a before-image - and is honest when it does not,
offering to turn before-image on for that table. Updates show before and after values the same way. ALFRED
also warns when the database itself removed related rows (cascading deletes) that the add-on cannot see.

**Why this priority**: Deletes and updates are where data damage happens; "3 rows deleted" without contents is
not enough to debug with. It depends on Story 1 only.

**Independent Test**: Record a call with a delete preceded by a read of the same rows, a delete on a table with
before-image on, and a delete on a table with it off; confirm the first two show the rows with their source and
the third says the contents were not captured and offers the switch.

**Acceptance Scenarios**:

1. **Given** a delete whose rows were read earlier in the same call, **When** its "deleted rows" are opened,
   **Then** the rows are shown, labelled with the earlier statement they came from and a note that they could
   have changed in between.
2. **Given** before-image is on for a table, **When** a delete or update runs on it, **Then** the affected rows are
   recorded just before the change, and the window shows them with the extra time the read cost.
3. **Given** before-image is off and no earlier read exists, **When** the user opens the delete, **Then** the window
   states that the contents were not captured and offers to turn before-image on for that table.
4. **Given** a delete or update with no condition, **When** the window opens, **Then** it is flagged in red as
   affecting the whole table, and the user can mark it as expected for that table so it no longer raises a flag.
5. **Given** a table the database cascades deletes from, **When** a delete runs on it, **Then** the window warns that
   related rows were removed by the database and are not visible.
6. **Given** a delete inside a transaction that rolled back, **When** the window opens, **Then** it says nothing was
   deleted and shows the rows it would have removed if they are known.

---

### Deferred to a later feature: Relive integration

Stories 5-7 are **not built in this feature**. They stay here as the target the captured data and the capture
add-on must support (FR-040 to FR-043).

### User Story 5 - Replay a call without touching the real database (Deferred)

In a Relive Cycle, the developer sets a step's database mode to REPLAY. When the step runs, every statement the
application issues is answered from the recording - reads return the recorded rows, writes report the recorded
counts - and nothing reaches the real database. The developer can replay a payment as many times as they like
and the wallet never changes. A statement that does not match the recording is never sent to the database;
the step reports it clearly.

**Why this priority**: This removes the reason replay is unsafe today, but it builds on Stories 1-2 (it needs
recordings) and on the existing Relive feature.

**Independent Test**: Record a payment call, replay it 10 times with database mode REPLAY, and confirm the real
balance is unchanged and every statement shows as answered from the recording.

**Acceptance Scenarios**:

1. **Given** a step in REPLAY database mode, **When** the run executes it, **Then** every statement that matches its
   recording is answered from the recording and the real database receives none of them.
2. **Given** a statement that differs from the recording (for example a value the application generated itself),
   **When** it arrives during REPLAY, **Then** it is not sent to the database; the step shows which value differed
   and offers to ignore that value for this step or answer with the recording anyway.
3. **Given** values that legitimately change between runs (current time, generated identifiers), **When** the user
   marks them as ignored for a step, **Then** later runs match despite them.
4. **Given** a step in LIVE database mode, **When** it runs, **Then** its statements reach the real database and the
   step's settings warn that writes and deletes really happen.
5. **Given** a run, **When** it finishes, **Then** each statement shows whether it was replayed, ran live, or did not
   match.

---

### User Story 6 - What-if, pause and fault injection on statements (Deferred)

During a replay the developer wants to test paths the recording never took: the balance was 50 instead of 500,
the delete found nothing, the insert hit a deadlock. For any statement they can edit the rows or the count
Relive answers with, make the statement fail with a chosen database error, or pause the run just before the
statement is answered to look and edit, then continue.

**Why this priority**: High debugging value, but only once replay (Story 5) exists.

**Independent Test**: Edit a recorded balance to 50, replay the payment step and confirm the application takes
its insufficient-funds path; mark another statement to fail with a deadlock and confirm the application's error
handling runs.

**Acceptance Scenarios**:

1. **Given** a recorded read, **When** the user edits its rows for replay and saves them to the step, **Then** later
   replays answer with the edited rows, and the statement is marked as a what-if.
2. **Given** a recorded write or delete, **When** the user sets a different count (for example 0 deleted), **Then**
   replays answer with that count.
3. **Given** a statement, **When** the user chooses "fail it instead" with an error (deadlock, unique constraint,
   timeout, connection lost), **Then** replays raise that error to the application.
4. **Given** a statement marked to pause, **When** a run reaches it, **Then** the run waits in ALFRED's existing
   paused-calls screen, where the user can inspect and edit the answer before continuing; an unanswered pause
   times out with a defined default, as pauses do today.
5. **Given** any what-if, failure or pause, **When** the user clears it, **Then** the statement goes back to being
   answered from the recording.

---

### User Story 7 - Compare a run's database work with the recording (Deferred)

After a run, the developer compares its statements with the recording (or with another call or another run)
and sees what is identical, what changed (and which value), what is missing and what is extra - for example,
a commit in the recording that became a rollback in the run.

**Why this priority**: It answers "why did it behave differently this time?", but it depends on replay runs and is
the least essential for a first release.

**Independent Test**: Run a step whose application code now generates a different reference; confirm Compare
shows that statement as changed with the old and new value, the following commit as missing, and a rollback as
extra.

**Acceptance Scenarios**:

1. **Given** a recording and a run of it, **When** the user opens Compare, **Then** identical statements are folded
   into one line and each difference is listed as changed, missing or extra, in run order.
2. **Given** a changed statement, **When** the user expands it, **Then** they see exactly which value differed and
   can trace that value, ignore it for the step, or answer with the recording anyway.

---

### Edge Cases

- **Add-on not attached or ALFRED down**: the application runs exactly as it would without ALFRED; captured data
  is lost for that period, never the application's own work. Calls show as "not captured", distinct from "no
  statements".
- **Database work with no inbound call** (scheduled jobs, message listeners, startup): kept in a separate
  "outside any call" bucket grouped by thread, never mixed into a call.
- **Work handed to another thread** by the application during a call: still attributed to the call that started it.
- **Very large results**: rows beyond the per-result limit are not kept; the statement and its total count are
  always kept, and the window states how many rows were dropped. This is the only place data is capped.
- **Batched statements**: shown as one line with every parameter set available.
- **Stored procedures**: shown with their input values and the values they returned.
- **Large binary or text values**: shown as a size marker and opened on demand; never truncated in exports.
- **Sensitive values**: always shown in full inside ALFRED; masked only in exports, and only for columns the user
  added a redaction rule for.
- **Huge numbers of statements** (thousands in one call): the window stays responsive; repeated queries fold
  into one line.
- **Statements still running**: a statement appears once it finishes; while its call is still in progress the chip
  shows "live" and the window keeps adding statements as they complete. A statement that never finishes (the
  application was killed) never appears; the call's summary says capture ended early.
- **Cascading deletes**: related rows the database removes on its own cannot be captured; ALFRED warns instead.
- **Savepoints and partial rollbacks**: shown as their own transaction lines.
- **Deleting captured data**: statements belong to their call; deleting or clearing the call, or the call ageing out
  of retention, removes them. Statements of calls kept in a session cycle or a Relive Cycle live as long as it does.
- **(Deferred, Relive) REPLAY with the add-on detached**: the run warns before starting that database statements cannot be
  answered and would reach the real database, and does not start database-REPLAY steps without explicit
  confirmation.

## Requirements *(mandatory)*

### Functional Requirements

**Capture**

- **FR-001**: The system MUST capture every database statement an attached application runs, with the
  statement text, its parameter values and types, its outcome (rows returned, rows affected, generated keys,
  returned procedure values, or the error), its duration, its thread, and the code location that issued it.
- **FR-002**: The system MUST attribute each captured statement to the inbound call that caused it, exactly,
  including when many inbound calls run concurrently and when the application hands work to another thread.
- **FR-003**: The system MUST record the exact order of a call's statements and its outbound supplier calls
  relative to each other, independent of clock differences between components.
- **FR-004**: The system MUST record transaction boundaries (commit, rollback, savepoints) and which statements
  each transaction contained.
- **FR-005**: Capture MUST NOT change the application's behaviour or results, and MUST NOT make the application
  wait on ALFRED; if ALFRED is unreachable, the application continues and only the captured data is lost.
- **FR-006**: Capture MUST be attachable to a running application without restarting it, and without changes to
  the application's code or configuration of its database access. It MUST work on applications running Java 8 or newer.
- **FR-007**: The system MUST keep statements that ran outside any inbound call separately, grouped by thread.
- **FR-008**: The system MUST capture every parameter value and every returned value in full and show them in full
  in the window and in tracing. ALFRED's redaction rules MUST be extended with a database-column kind that masks
  that column's values, and the parameters bound to that column, in every export format - the same export-only
  behaviour redaction rules have today.
- **FR-009**: The system MUST store all rows of a result up to a configurable per-result limit (default 50,000)
  and always store the total count; the user MUST be told when rows were not kept.
- **FR-010**: The system MUST support an opt-in, per-table before-image that records the rows an update or
  delete is about to change, read in the same transaction just before the change.
- **FR-011**: The system MUST let the user exclude statements from capture (for example health checks or
  scheduler tables) by pattern.

**Control**

- **FR-012**: Users MUST be able to turn capture on or off per project from the Live Calls Sources bar, the
  Session Cycles widget's Sources panel and the Settings page; all three MUST show the same state and update
  live for every user.
- **FR-013**: Database capture MUST be unavailable for a project while its inbound logging is off, with an
  explanation.
- **FR-014**: The system MUST show, per project, whether the add-on is attached and when it was last seen, with
  instructions to attach it when it is not.

**Viewing**

- **FR-015**: Each call MUST show a database summary (statements, writes, failures, number of flags) without
  listing statements in the call list; the summary MUST distinguish "no statements" from "not captured".
- **FR-016**: Opening the summary MUST show a database window listing the call's statements, one collapsed line
  each (order number, kind, statement with values, result, duration, offset from the call's start), expandable
  to full detail.
- **FR-017**: Transactions and runs of the same query MUST appear as foldable parent lines with their statements
  under them; repeated queries MUST start folded.
- **FR-018**: Supplier calls MUST appear in the statement list at the point they happened, can be hidden, and
  link to their own call.
- **FR-019**: Failed statements MUST show the database error; statements of rolled-back transactions MUST be
  marked as not saved; a failure the call recovered from MUST be called out.
- **FR-020**: The window MUST show the statements of a call that is still running as they arrive, without polling.
- **FR-021**: For deletes, the window MUST show the removed rows from, in order of preference, an earlier read of
  the same rows in the same call, or a before-image; otherwise it MUST state that contents were not captured and
  offer to enable before-image for that table. Updates MUST show before and after values on the same basis.
- **FR-022**: The window MUST warn when a delete's table cascades to other tables whose removed rows cannot be
  seen.

**Investigating**

- **FR-023**: The window MUST raise flags, each linking to its statement, for at least: failed statements
  (and whether they were swallowed), rollbacks, updates or deletes without a condition, deletes above a row
  threshold, repeated queries above a repeat threshold, slow statements, results above a row threshold,
  locks held during a supplier call, cascading deletes, and writes whose before state was not captured.
  Thresholds MUST be configurable, and a statement MUST be markable as expected so it stops raising a flag.
- **FR-024**: The window MUST show where the call's time went (database, suppliers, application) along the
  call's duration, each part linking to its statement.
- **FR-025**: Users MUST be able to search statements, filter them by kind (reads, writes, deletes, failures)
  and by table, and see a per-table summary of reads, inserts, updates, deleted rows, failures and time.
- **FR-026**: Users MUST be able to trace any value across the call: every statement parameter, returned row,
  deleted row and supplier request or response body containing it, in run order.
- **FR-027**: Users MUST be able to search, sort and query (with SQL: selection, conditions, grouping,
  ordering, limits) a statement's recorded rows and the call's statement list. Such queries MUST run only on
  recorded data, never on the application's database.
- **FR-028**: Large results MUST be shown in a fixed-height, scrollable table that loads further rows on demand.
- **FR-029**: Users MUST be able to copy a statement with its values filled in, and export a call's statements.
  Captured statements MUST be included, untruncated, in the call's existing document and data exports, and
  round-trip through the data export's re-import.

**Replay (Relive) - deferred to a later feature, not built here**

- **FR-030**: Each Relive step MUST have a database mode, REPLAY or LIVE, alongside its existing supplier mode.
- **FR-031**: In REPLAY, every statement matching its recording MUST be answered from the recording and MUST NOT
  reach the real database; a statement that does not match MUST NOT reach the real database either, and the
  step MUST report which values differed.
- **FR-032**: Users MUST be able to mark values to ignore when matching, per step.
- **FR-033**: Users MUST be able to set, per statement, edited rows, an edited affected-row count, or a chosen
  database error for replay, and clear them again.
- **FR-034**: Users MUST be able to pause a run before a chosen statement is answered, using ALFRED's existing
  paused-calls flow, with its timeout and default action.
- **FR-035**: A run MUST record, per statement, whether it was replayed, ran live, was edited, failed on purpose,
  or did not match.
- **FR-036**: Users MUST be able to compare a call's or run's statements with another (recording vs run, or
  any two calls) and see identical, changed (with the differing values), missing and extra statements.
- **FR-037**: A run whose steps use database REPLAY MUST warn before starting if the add-on is not attached to
  the application, and MUST NOT run those steps against the real database without explicit confirmation.

**Built now so Relive can be added later**

- **FR-040**: Captured data MUST be complete enough to answer a statement later without the database: the
  statement text with placeholders, every parameter value with its type (per set for batches), the full outcome
  (all stored rows with column names and types, affected counts, generated keys, procedure outputs, or the
  error with its codes), and transaction boundaries.
- **FR-041**: Each captured statement MUST carry a stable identity within its call (its order number and a
  fingerprint of its text and parameter types) so a later run can match a live statement to its recording.
- **FR-042**: The capture add-on MUST be structured so that, per statement, a later version can return a supplied
  result or error instead of calling the database, and can wait for a decision before answering - without
  changing how capture works. This feature ships capture only; the answering path stays unused.
- **FR-043**: The add-on MUST recognise the run tag ALFRED already puts on Relive traffic and record it on the
  statements it captures, so later runs can find their own statements.

**Data lifecycle**

- **FR-038**: Captured statements MUST be deleted with their call (deletion, clearing, retention ageing) and kept
  as long as a session cycle or Relive Cycle holding that call keeps it.
- **FR-039**: Captured statement storage MUST have an explicit size limit, consistent with ALFRED's other stores.

### Key Entities

- **Captured Statement**: one database operation within a call - order number, kind, statement text,
  parameters (or parameter sets for a batch), outcome (rows, count, keys, procedure outputs or error),
  duration, offset, thread, code location, transaction it belonged to, and an optional before-image.
- **Statement Transaction**: a group of statements committed or rolled back together - outcome, how long it
  was held, connection.
- **Result Rows**: the rows a statement returned (or a before-image held), with their columns; stored up to the
  per-result limit with the true total count.
- **Capture Setting (per project)**: on/off, add-on status and last seen, before-image tables, per-result row
  limit, flag thresholds, statements marked expected, excluded patterns.
- **Statement Replay Setting (per Relive step)** *(deferred, Relive)*: database mode, ignored values, and per-statement overrides
  (edited rows, edited count, injected error, pause).
- **Statement Run Outcome** *(deferred, Relive)*: for each statement in a run - replayed, live, edited, failed on purpose, or not
  matched, with the differing values when not matched.

Relationships: an inbound call has zero or more captured statements and transactions; statements outside any
call belong to a thread bucket; a Relive step references a recorded call and carries one replay setting; a run
records one outcome per statement.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With 50 inbound calls running at the same time, 100% of captured statements are attributed to the
  call that caused them (no missing and no misattributed statements).
- **SC-002**: Attaching capture adds no more than 5% to the application's response time for a typical call
  (around 50 statements), and the application's responses are byte-for-byte the same with capture on or off.
- **SC-003**: With ALFRED stopped, the attached application keeps serving calls with no errors and no added
  waiting.
- **SC-004** *(deferred, Relive)*: Replaying a recorded call that writes and deletes data 10 times in REPLAY database mode leaves the
  real database exactly as it was (zero rows changed).
- **SC-005**: The database window for a call with 500 statements opens and becomes usable in under 1 second; a
  result whose 50,000 stored rows are scrolled end to end never freezes the page, and a 100,000-row result shows
  its stored 50,000 rows plus a clear note that the remaining 50,000 were not kept.
- **SC-006**: Given a call with one failed-and-swallowed statement among 200, a developer new to the feature
  finds it in under 30 seconds.
- **SC-007**: For every flag type listed in FR-023, a call that contains the problem raises the flag and a call
  that does not, does not (no false positives on the reference recordings).
- **SC-008**: Exports of a call with captured statements contain every statement and every stored row
  (verified by the existing no-truncation checks), and re-importing the data export restores them identically.
- **SC-010**: The reference recordings for each of Oracle, PostgreSQL, MySQL/MariaDB and SQL Server display every
  captured value (including vendor-specific types) and every error code correctly, with no value shown as
  unknown or unreadable.
- **SC-009**: Toggling capture in any of the three places is reflected in the other two within 2 seconds for
  every open page.

## Assumptions

- The applications ALFRED fronts are Java applications (as today), running on a Java application server such as
  WildFly, on Java 8 or newer; the capture add-on must attach to and run on Java 8 and every later version. Non-Java applications are
  out of scope for this feature (a network-level capture for them is a possible later feature behind the same
  stored format).
- Relational databases reached through the standard Java database interface are in scope, whatever the
  vendor. Vendor-specific value types and error codes are handled for Oracle, PostgreSQL, MySQL/MariaDB and
  SQL Server (for example Oracle cursors and object types, PostgreSQL JSON and array columns); other vendors
  get standard types only. Non-relational stores (document stores, caches, message brokers) are out of scope.
- ALFRED never connects to the application's database itself. The only reads beyond the application's own are
  before-images, which the user turns on per table and which run inside the application's own transaction.
- Inbound calls reach the application through ALFRED's reverse proxy, which already tags them; calls that bypass
  it cannot be attributed and land in the "outside any call" bucket.
- Supplier-call ordering and attribution improve as a side effect (the add-on tags outbound calls with their
  inbound call and order); where the add-on is absent, today's attribution and time-based ordering remain,
  shown as approximate.
- Retention follows the call it belongs to; the default per-result row limit is 50,000, and the store's overall
  size limit follows the same pattern as ALFRED's other stores.
- This feature delivers Stories 1-2 first (capture, attribution, the window, switches), then Stories 3-4
  (investigation, deletes and updates). Stories 5-7 (replay, what-if, pause, fault injection, compare) are a later
  feature built on FR-040 to FR-043. Each phase is usable on its own.
- The agreed visual design is [mock.html](mock.html); the implementation follows it and ALFRED's existing call
  card, dialog and Sources bar styles.
