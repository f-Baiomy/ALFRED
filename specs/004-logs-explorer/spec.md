# Feature Specification: Logs Explorer

**Feature Branch**: `004-logs-explorer`
**Created**: 2026-10-03
**Status**: Draft
**Input**: User description: "The previously discussed task (Logs Explorer: read, view, group and search logs of any structure, one JSON object per line, from files, live tails, HTTP push and OpenSearch), plus a detailed, dynamic `mock.html` design before implementing."

## Overview

Teams keep large application logs where every line is one JSON object, for example a 10 GB export from
OpenSearch (~3-4 million lines of ~3 KB each), or the raw `detail.log` an application writes. Today ALFRED
cannot read them. The Logs Explorer adds a **Logs** section to ALFRED that loads logs of **any** structure,
lets the user describe that structure once (field types, roles, search modes, grouping levels, display
template), and then browse, search, group and inspect millions of lines quickly, without any data being
cut or summarized.

Terminology:

- **Log line**: one line of input, one JSON object. Kept exactly as received.
- **Structure**: the set of fields a family of log lines has (all lines of one source share it), plus the
  user's settings for those fields.
- **Field**: one value inside a line, named by its full path (`_source.attributes.message.correlationId`).
  Nested objects are flattened into paths; one-element lists are unwrapped; JSON stored inside a text value
  is unpacked into further fields.
- **Log source**: a named collection of log lines that share one structure, fed by one or more inputs.
- **Input**: one way lines reach a source: uploaded file, file on the server, followed (growing) file,
  lines pushed by another system, or a pull from an OpenSearch cluster.
- **Role**: the meaning a field has for display and future features (time, level, correlation, message,
  service, duration, status, request body, response body, error).
- **Grouping levels**: an ordered list of ID fields (for example session-id → inbound-call-id →
  external-call-id) that arranges log lines into parents and children.

## Clarifications

### Session 2026-10-03 (design discussion before specification)

- Q: What can the logs look like? → A: Any JSON structure, one object per line; all lines of one source share
  the same structure with different values. Structure is detected automatically, never hard-coded.
- Q: What matters most: search speed or disk size? → A: Fast search. The user chooses, per field, whether it
  is searched by exact value, searched as text (any fragment), or not searched; only chosen fields cost
  index space.
- Q: Is it search only? → A: No. Viewing in a friendly way matters as much: summary lines, roles, templates,
  trees, comments; later, selected lines become ALFRED calls (out of scope now, but the design must allow it).
- Q: Must ALFRED keep working if the original file is deleted? → A: The user chooses per load: copy the raw
  lines into ALFRED, or keep only positions into the original file.
- Q: Finished files only, or live? → A: Both: finished files and growing files followed live.
- Q: How do lines reach ALFRED? → A: Upload through the UI, a file already on the server, a followed file,
  lines pushed over HTTP, and pulls from OpenSearch (or similar sources later).
- Q: Remote sources: copy or query in place? → A: The user picks per source. Lines that get a comment are
  always kept in ALFRED (pinned) so they survive remote deletion.
- Q: One file or many? → A: Log sources group many files and inputs of the same structure; search, groups and
  traces span all of them.
- Q: Show a field on every row? → A: "Toggle column", the same as OpenSearch Discover. With no columns
  chosen, rows show the summary line; with columns chosen, rows show those columns.
- Q: Per-field actions? → A: Filter for value, filter out value, toggle column, filter for field present.
- Q: Grouping? → A: An ordered list of ID fields, any depth. A line's level is the number of those IDs it
  carries (A only = level 1; A+B = level 2; A+B+C = level 3; ...). Its parent is the line one level up with
  the same leading IDs (one-to-many, like session → inbound call → external call). Parents and children are
  ordinary log lines with the same rows, expand, detail and all fields. Every level can be sorted by any
  property. Nothing is truncated.
- Q: Collapsing? → A: Every line has two independent toggles: one for its children, one for its own data.
- Q: How is a line's data shown? → A: The user switches between Table and JSON.
- Q: Selecting? → A: Multi-select of lines (range, keyboard, all matching) with bulk actions; compare is one
  of them (exactly two lines).

### Session 2026-10-03 (/speckit.clarify)

- Q: How is a log line identified (identical lines; reloading a file)? → A: By the input it came from plus its
  position in that input (remote ID for OpenSearch). Identical lines stay separate; loading a file again is a
  new input and creates a second copy (ALFRED warns first); comments stay on the lines they were made on.
- Q: What do the Logs screens do with personal data? → A: The user chooses, per source: show as-is, mask
  fields marked sensitive until revealed, or redact them at load (originals not kept). Exports always pass
  through ALFRED's redaction rules.
- Q: Which time zone are times shown in? → A: A per-source setting (part of the structure settings).
- Q: What happens if pushed lines arrive (or an OpenSearch pull runs) while ALFRED is busy or restarting? → A:
  ALFRED rejects the push with an error so the sender retries; OpenSearch follow resumes from its last saved
  position. Nothing is buffered in memory and nothing is silently lost.
- Q: Sidebar value counts and field stats over millions of lines: exact or sampled? → A: From the latest 10,000
  matches (labelled as such); percentiles are exact for fields set to Exact search.
- Q: Who is a comment's author? → A: The viewer picks one of ALFRED's existing profiles (remembered in the
  browser); comments show that profile's name and emoji.
- Q: Which time range does the explorer open with? → A: The one the viewer last used for that source
  (remembered in the browser); the very first visit opens on the last 24 hours of data.
- Q: Deleting a source that has comments or pinned lines? → A: A confirmation states how many comments and
  pinned lines will be lost; confirming deletes everything.
- Q: Field types? → A: Date, datetime, number, string, boolean. Detected automatically at first read; the
  user can change the type (and its format) while loading or at any time after. Types drive sorting, range
  filters, checks and rules.
- Q: Storage engine? → A: The current embedded store now; a document database will replace it later, so the
  design must not depend on the current engine.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Load a large log file and browse it (Priority: P1)

A support engineer has a 10 GB OpenSearch export. They create a log source, point it at the file (upload or
a file already on the server), check the detected structure, and open the explorer. Lines appear newest
first, each as a one-line summary coloured by level, and scrolling moves smoothly through millions of lines.

**Why this priority**: Nothing else works without loading and viewing. It is the MVP.

**Independent Test**: Load a generated 10 GB sample file; scroll from the top to the middle and the end;
open any line and compare it with the original line in the file.

**Acceptance Scenarios**:

1. **Given** a 10 GB file of one-JSON-object-per-line logs, **When** the user loads it, **Then** a progress
   indicator shows lines read, bytes read and time remaining, and the user can open the explorer before the
   load finishes (already-loaded lines are browsable).
2. **Given** a loaded source, **When** the user opens any line, **Then** every field and the raw line are
   shown in full, identical to the input.
3. **Given** a line that is not valid JSON, **When** loading reaches it, **Then** it is kept as an "unparsed
   line" (raw text visible, counted on the source), and loading continues.
4. **Given** the user chose "keep positions only", **When** they open a line, **Then** its raw text is read
   from the original file; if that file is gone or changed, the line says so instead of showing wrong data.

---

### User Story 2 - Describe the structure: types, roles, search modes, template (Priority: P1)

Before (or after) loading, the user sees the detected fields as a list of paths with a sample value each.
For every field ALFRED has pre-filled a type (with how many sample values matched), a role guess and a
search mode. The user corrects what is wrong, writes a summary template like
`{time} {level} {methodName} · {message}`, and sees a live preview of a real line.

**Why this priority**: Types, roles and search modes decide how fast and how readable everything else is.

**Independent Test**: Load a sample with a date field in a custom format and a 0/1 flag field; change the
first to datetime with the right pattern and the second to boolean; verify sorting and filtering follow the
new types and that unconvertible values are counted and listed.

**Acceptance Scenarios**:

1. **Given** a first read, **When** detection finishes, **Then** every field has a type (date, datetime,
   number, string, boolean), a match rate ("99.8% · 2 invalid") and a suggested role where one is obvious.
2. **Given** a loaded source, **When** the user changes a field's type, **Then** the field is re-converted in
   the background, the rest of the explorer stays usable, and values that do not fit are kept as their
   original text, counted and listable.
3. **Given** a text value that itself holds JSON, **When** detected, **Then** its inner fields become
   ordinary fields; if they duplicate other fields, they are marked "duplicate" and not searched by default.
4. **Given** a summary template, **When** the user edits it, **Then** the preview updates immediately using
   a real line.
5. **Given** a later file with the same structure, **When** it is added, **Then** all saved settings apply
   automatically.

---

### User Story 3 - Search and filter fast (Priority: P1)

The user types filters as pills (`statusCode ≠ 200`, `externalService = Sabre`, `"timeout"`), picks a time
range, and sees the matching lines, a histogram of matches over time stacked by level, and per-field value
counts in a sidebar. Clicking a value or a field action adds a pill.

**Why this priority**: Finding the right lines in millions is the core reason to load logs at all.

**Independent Test**: On a 10 GB source, run an exact-value filter, a text fragment search, a range filter on
a number field and a "field present" filter; measure response time and check results against a brute-force
scan of the file.

**Acceptance Scenarios**:

1. **Given** a field set to exact search, **When** the user filters on a value, **Then** results appear in
   under one second.
2. **Given** a field set to text search, **When** the user searches a fragment from the middle of a value
   (`anotrav` in `evilanotravel@gmail.com`), **Then** matching lines are found and the fragment is
   highlighted.
3. **Given** a field set to "not searched", **When** the user filters on it anyway, **Then** the search still
   works, with a notice that it is slower.
4. **Given** any field row in the detail or sidebar, **When** the user clicks filter for value / filter out
   value / field present, **Then** the matching pill is added and results refresh.
5. **Given** typed fields, **When** the user uses `>`, `<` or "between" on a number, date or datetime field,
   **Then** the comparison follows the field's type, not text order.
6. **Given** a useful combination of pills and time range, **When** the user saves it as a view, **Then** it
   can be reopened in one click.

---

### User Story 4 - Grouped view by levels (Priority: P2)

The structure defines grouping levels, for example session-id → inbound-call-id → external-call-id. The
explorer's Grouped view shows each session line with its inbound-call lines nested under it and their
external-call lines nested under those. Each level is sorted by the property the user picks.

**Why this priority**: Real investigations follow a session or an inbound call through everything it caused.

**Independent Test**: Load a sample containing 3 levels with a missing parent, duplicate same-level lines and
a skipped level; check placement and counts against the level rule.

**Acceptance Scenarios**:

1. **Given** levels A, B, C, **When** a line has A only / A+B / A+B+C, **Then** it is shown at level 1 / 2 / 3
   under the line one level up with the same leading IDs.
2. **Given** level-2 lines whose level-1 line does not exist, **When** grouped, **Then** they appear under a
   placeholder row ("A = 123 · no level-1 line").
3. **Given** several lines at one level with identical IDs, **When** grouped, **Then** the earliest is the
   parent row and the others appear directly below it as siblings.
4. **Given** a line with A and C but no B, **When** grouped, **Then** it sits under its nearest existing
   ancestor marked "B missing".
5. **Given** a parent row, **When** the user toggles its children, **Then** children load and show without
   any "and N more" cut-off; every child is reachable by scrolling.
6. **Given** any row, **When** the user toggles its data, **Then** that line's full data opens inline,
   independently of whether its children are open.
7. **Given** a sort choice per level (time, any field, line count, error count, max duration), **When**
   applied, **Then** each level reorders without affecting other levels.

---

### User Story 5 - Inspect a line: Table or JSON, columns, compare, stats (Priority: P2)

From any row the user opens the line's data inline (Table or JSON, their choice) or in a side drawer with
tabs Fields, Raw, Context, Trace, Comments. They toggle useful fields into columns, compare two selected
lines field by field, and open stats for a field (top values, or percentiles and distribution for numbers
and dates).

**Why this priority**: This is how the user reads a line without hunting for it in raw JSON.

**Independent Test**: Toggle three fields into columns, reload, and see them kept; compare two lines and see
only the differing fields highlighted; open stats on a number field and verify p50/p95 on a known sample.

**Acceptance Scenarios**:

1. **Given** a line's data open, **When** the user switches Table ↔ JSON, **Then** the same complete content
   shows in the other form, and the choice is remembered for the source.
2. **Given** the JSON form, **When** the user folds a nested object, **Then** it collapses to a one-line
   summary (`{ … 5 fields }`) and can be reopened.
3. **Given** "toggle column" on a field, **When** clicked, **Then** that field appears as a column on every
   row; clicking again removes it; the column set is saved per structure.
4. **Given** "Context", **When** opened, **Then** the 20 lines before and after this line in original input
   order are shown.
5. **Given** two selected rows, **When** "Compare" is used, **Then** all fields are listed side by side with
   differences highlighted and an "only differences" switch.
6. **Given** the list, **When** the user ticks rows (click, shift-click for a range, keyboard select and
   extend, header box for all loaded rows, "select all N matching" for the whole result), **Then** a bar
   shows the count and bulk actions: compare (exactly two), show selection only, copy raw lines, export
   (raw lines, JSON, Markdown, HTML) in full, comment on all, pin, and (later phase) make ALFRED calls.
7. **Given** a selection in the grouped view, **When** "+ children of selected" is used, **Then** every
   descendant of each selected line is added.
8. **Given** a selection, **When** filters change, **Then** the selection is kept and the bar says how many
   selected lines the current filters hide.

---

### User Story 6 - Live logs: follow a file, accept pushed lines (Priority: P2)

The user adds a "follow" input for a growing log file, or gives another system a push address. New lines
appear in the explorer as they arrive; if the user has scrolled away, a "N new lines" notice appears instead
of the list jumping.

**Why this priority**: Watching a live system is the second main use, after reading exported files.

**Independent Test**: Append lines to a followed file, rotate it, restart ALFRED, and verify no line is lost
or duplicated; push lines over HTTP with a wrong and a right token.

**Acceptance Scenarios**:

1. **Given** a followed file, **When** lines are appended, **Then** they appear within 2 seconds.
2. **Given** the file is rotated (renamed or truncated and recreated), **When** following, **Then** ALFRED
   continues with the new file without losing or repeating lines.
3. **Given** ALFRED restarts, **When** following resumes, **Then** it continues from the last line read.
4. **Given** a push input, **When** a request arrives without the source's token, **Then** it is rejected and
   nothing is stored.

---

### User Story 7 - OpenSearch as a source (Priority: P3)

The user connects an OpenSearch cluster (address, index pattern, query, time range, credentials) and either
imports matching lines into ALFRED (once, or continuously following new ones) or browses them in place without
copying.

**Why this priority**: Saves the manual export step and supports live production investigation.

**Independent Test**: Import a time range larger than 10,000 hits and verify the count matches the cluster;
browse in place and verify filters return the same lines as in OpenSearch.

**Acceptance Scenarios**:

1. **Given** a query matching more than 10,000 lines, **When** imported, **Then** all of them arrive.
2. **Given** follow mode, **When** new lines are indexed in OpenSearch, **Then** they arrive in ALFRED
   within the configured interval.
3. **Given** in-place mode, **When** the user comments on a line, **Then** that line is copied into ALFRED
   and stays available after OpenSearch deletes it.
4. **Given** saved credentials, **When** the user reopens the source settings, **Then** the secret is never
   shown back, only "set" with a replace option.
5. **Given** import or follow, **When** running, **Then** ALFRED respects a configurable size and rate limit
   so it never overloads the cluster.

---

### User Story 8 - Comments, patterns, minimap, traces (Priority: P3)

The user comments on a line (or a field of a line); comments stay with that line for as long as it exists. A Patterns
view groups similar lines into templates with counts. A minimap next to the list shows where errors are in
the whole result. A Trace view lays out all lines sharing a correlation value as a timeline with duration
bars.

**Why this priority**: These speed up investigations but are not needed to read and search logs.

**Independent Test**: Comment on a line, let retention remove its neighbours, and see the commented line
and comment still there; check that patterns group lines differing only in IDs or numbers.

**Acceptance Scenarios**:

1. **Given** a comment on a line, **When** retention removes older lines or the remote source deletes it,
   **Then** the commented line and its comment remain. **Given** the same file is loaded again, **Then** it is
   a new input with its own lines and the existing comments stay on the original lines.
2. **Given** Patterns view, **When** opened, **Then** lines that differ only in variable parts are grouped
   with a count, and opening a pattern lists all its lines.
3. **Given** the minimap, **When** the user clicks a mark, **Then** the list jumps to that position.

### Edge Cases

- Lines of very different size (100 bytes to several MB): all are stored and shown in full; only the row
  display is shortened, with the full value one click away.
- A field appears only after the detection sample: it is added to the structure when first seen and the user
  is notified.
- Two different structures sent to the same source: lines that do not match are flagged as "different
  structure" with an option to start a new source from them.
- A value that is JSON in text form but invalid: kept as text.
- Same file loaded twice: ALFRED recognizes the file (same name, size and leading content) and warns before
  loading; if the user continues, it becomes a second input with its own copy of every line.
- Two byte-identical lines in one input: both are kept as separate lines.
- A comment's author profile is deleted later: the comment stays and shows "deleted profile".
- Push or OpenSearch pull while ALFRED is busy or restarting: the push is rejected with a retryable error;
  the pull resumes from its last saved position; no line is silently dropped.
- Disk space runs low during a load: loading pauses with a clear message; nothing already loaded is lost.
- A followed file disappears: the input shows "waiting for file" and resumes when it returns.
- Retention limit reached: oldest lines are removed first; lines with comments are never removed.
- Changing a field's search mode on 4 million lines: rebuild runs in the background with progress; search on
  that field shows "rebuilding" until done.
- Sensitive data (emails, device fingerprints) in lines: handled per the source's privacy setting (show,
  mask until revealed, or redact at load); anything exported goes through ALFRED's existing redaction rules.

## Requirements *(mandatory)*

### Functional Requirements

**Sources and inputs**

- **FR-001**: Users MUST be able to create, rename and delete log sources, each holding one structure and any
  number of inputs. Deleting asks for confirmation stating how many lines, comments and pinned lines will be
  removed; confirming removes all of them.
- **FR-002**: Users MUST be able to add these inputs to a source: uploaded file, file on the server (chosen
  from an allowed folder only), followed growing file, lines pushed by another system, OpenSearch pull.
- **FR-003**: Uploads MUST support files of at least 10 GB and survive network limits on single requests.
- **FR-004**: Each input MUST show its status (loading with progress, done, following, waiting, failed with
  reason) and can be paused, resumed or removed.
- **FR-005**: Users MUST choose per load whether raw lines are copied into ALFRED or only positions into the
  original file are kept.
- **FR-006**: Followed files MUST resume after restart and survive rotation without losing or repeating lines.
- **FR-007**: Pushed lines MUST be accepted only with the source's secret token. When ALFRED cannot store a
  push right away (busy, restarting), it MUST reject it with a retryable error rather than buffer or drop it;
  OpenSearch import/follow MUST resume from its last saved position after any failure.
- **FR-043**: Each source MUST have a privacy setting chosen by the user: show as-is, mask fields marked
  sensitive until the viewer reveals them, or redact them at load (originals not kept). Fields are marked
  sensitive in the structure. Exports always apply ALFRED's redaction rules.
- **FR-044**: Each source MUST have a display time zone in its structure settings; all times in its screens
  use it, with the raw value available on hover.
- **FR-045**: Lines whose field set differs from the source's structure by more than half of its fields MUST be
  counted as "different structure" per input, listed, and movable into a new source.
- **FR-046**: Loading MUST pause when free disk space falls below a configurable threshold (default 2 GB),
  showing the reason, and resume on demand; no loaded line is lost.
- **FR-047**: Users MUST be able to view and change a source's retention (maximum size and maximum age) after
  creating it.
- **FR-048**: When a new input has the same structure as an existing source, ALFRED MUST offer to reuse that
  source's settings (default on) and skip the structure step.
- **FR-008**: OpenSearch inputs MUST support one-time import, continuous follow and in-place browsing, with
  size and rate limits and write-only credentials.
- **FR-009**: Each source MUST have a retention limit (by size or age); oldest lines go first; commented lines
  are never removed.

**Structure**

- **FR-010**: The system MUST detect a structure automatically from a sample of the first lines: flatten
  nested paths, unwrap one-element lists, unpack JSON stored as text, and recognize text like
  `Name(key=value, ...)` as key/value data.
- **FR-011**: Every field MUST have a type (date, datetime, number, string, boolean), auto-detected with a
  match rate, and editable with a format (date pattern and time zone, number unit, true/false words) during
  loading and at any time after.
- **FR-012**: Changing a type after loading MUST convert only that field, in the background; values that do
  not fit MUST be kept, counted and listable, never dropped.
- **FR-013**: Every field MUST have a search mode (exact, text, not searched) and an optional role.
- **FR-014**: Users MUST be able to write a summary template from fields and see a live preview.
- **FR-015**: Users MUST be able to define an ordered list of grouping levels (any depth) and a sort per level.
- **FR-016**: Structure settings MUST be saved and re-applied automatically to new inputs with the same
  structure.

**Viewing**

- **FR-017**: The explorer MUST show a line list with level colour, summary line or chosen columns,
  correlation colour mark and duration bar, scrolling smoothly through millions of lines.
- **FR-018**: Users MUST be able to toggle any field into a column from the detail and the sidebar; the
  column set is saved per structure.
- **FR-019**: Every row MUST have two independent toggles: children (grouped view) and its own data.
- **FR-020**: A line's data MUST be viewable as Table or as JSON (folding nested objects); the choice is
  remembered per source.
- **FR-021**: A side drawer MUST offer Fields, Raw, Context (±20 lines in input order), Trace and Comments.
- **FR-022**: The grouped view MUST place lines by the level rule (level = number of level IDs present;
  parent = line one level up with the same leading IDs), handle missing parents, same-level duplicates and
  skipped levels as described in the scenarios, and treat parents as ordinary lines.
- **FR-023**: No view, export or comment MAY truncate or summarize a line's data; long values are only
  shortened on screen with the full value one click away; every child is reachable.
- **FR-024**: Users MUST be able to compare two lines field by field with differences highlighted.
- **FR-025**: Users MUST be able to open field statistics: top values with counts for text; min, max,
  p50, p95, p99 and distribution for numbers and dates. Sidebar counts and stats are computed from the latest
  10,000 matching lines and say so; percentiles are exact for fields set to Exact search.
- **FR-026**: A Patterns view MUST group similar lines into templates with counts.
- **FR-027**: A minimap MUST show where lines matching a chosen condition (default: ERROR and WARN; any pill
  can be chosen) are in the whole result, and jump there on click. Above 5 million matches it is computed on an
  even sample of the result and says so.
- **FR-028**: New lines arriving while the user is scrolled away MUST show as an "N new lines" notice, not
  move the list.

- **FR-039**: Users MUST be able to select any number of lines (single, range, keyboard, all loaded, all
  matching the current search) and clear the selection; the selection persists across filter changes and
  reports how many selected lines are hidden.
- **FR-040**: A selection MUST offer bulk actions: compare (exactly two), show selection only, copy raw lines,
  export in full (raw lines, JSON, Markdown, HTML; never truncated), comment on all, and pin; in the grouped
  view also "add children of selected".
- **FR-041**: The selection model MUST be usable later as the input for turning lines into ALFRED calls.

**Search**

- **FR-029**: Users MUST be able to filter with pills: equals, not equals, greater/less than, between, exists,
  not exists, and free text; pills can be removed individually.
- **FR-030**: Field rows MUST offer filter for value, filter out value, toggle column and filter for field
  present.
- **FR-031**: The query bar MUST suggest fields and values with counts while typing.
- **FR-032**: Users MUST be able to pick a time range and zoom the histogram by dragging. The explorer opens
  with the range the viewer last used for that source; the first visit opens on the last 24 hours of data
  (ending at the source's newest line, so old exports still show lines).
- **FR-033**: Users MUST be able to save and reopen named views (pills, time range, columns, view mode).
- **FR-034**: Search and grouping MUST work the same whether lines are stored in ALFRED or browsed in place.

**Comments**

- **FR-035**: Users MUST be able to comment on a line or on one field of a line; commented lines are kept in
  ALFRED permanently, even when retention or the remote source removes them.
- **FR-042**: Users MUST be able to add a comment directly on any field line of the JSON view and on any row of
  the Table view, shown inline under that field. A field comment is anchored to the field's path, so the same
  comment appears in both views, and survives folding (a folded block shows how many comments it hides). A whole-line comment is offered at the top of the data.

**Platform**

- **FR-036**: Changes (new lines, load progress, structure rebuilds) MUST reach the open explorer as
  notifications that trigger a fresh fetch; the explorer MUST NOT poll.
- **FR-037**: The feature MUST NOT depend on the current storage engine, so a later move to a document
  database changes storage only, not behaviour.
- **FR-038**: The design MUST keep enough per-line information (roles, IDs, raw line) to later turn selected
  lines into ALFRED calls (that conversion itself is out of scope).

### Key Entities

- **Log source**: name, structure, inputs, raw-storage choice, retention, remote mode (import or in place),
  privacy setting (show / mask / redact at load), counts and size.
- **Structure**: identity derived from its field paths; fields; grouping levels; summary template; columns;
  default data view (Table/JSON); display time zone.
- **Field**: path, type, type source (detected or user-set), format, match statistics, search mode, role,
  sensitive flag, sample values.
- **Input**: kind, configuration, file fingerprint (to warn on reloading the same file), progress or follow
  position, status, last error.
- **Log line**: identity = its input plus its position in that input (or the remote ID for OpenSearch),
  source, input, time, level, group IDs
  and level, field values, raw line or its position in the original file.
- **Saved view**: name, pills, time range, columns, view mode, sorts.
- **Comment**: line identity, optional field, text, author (an ALFRED profile), time; owns a pinned copy of
  the line.
- **Pattern**: template text, count, sample lines.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A 10 GB file (~3.5 million lines) loads in under 5 minutes on the reference server, without
  ALFRED's memory use growing with file size.
- **SC-002**: After loading, a filter on an exact-search field returns its first page in under 1 second;
  a fragment search on a text-search field in under 2 seconds; 95% of page scrolls render in under 200 ms.
- **SC-003**: Opening any line shows data byte-for-byte identical to the input line in 100% of a random
  sample of 1,000 lines.
- **SC-004**: Expanding a parent in the grouped view shows its first children in under 1 second, with
  correct placement in 100% of a test file covering all level edge cases.
- **SC-005**: A followed file delivers appended lines to the open explorer within 2 seconds, with zero lost
  or duplicated lines across a rotation and a restart.
- **SC-006**: A user new to the feature can load a sample file, fix one type and one role, and find all
  error lines of one correlation value in under 5 minutes.
- **SC-007**: For a 10 GB source with 2 text-search fields, the search indexes (text and exact) take under
  1.5× the size of the indexed fields' data, and total storage stays under 2.5× the input with raw lines copied
  and under 1.2× with positions only.

## Assumptions

- Single shared ALFRED server, same trust model as the rest of ALFRED (no per-user permissions).
- Every line is a complete JSON object; multi-line JSON records are out of scope for v1.
- Detection samples the first 1,000 lines; later new fields are added as they appear.
- Default retention per source: 20 GB or 30 days, whichever comes first; user-changeable.
- Server-side files are read only from one configured folder mounted for this purpose.
- Context window default: 20 lines before and after.
- Converting log lines into ALFRED calls, and the move to a document database, are later features.
- A working `mock.html` design in this folder is an approval gate before planning and implementation; no
  implementation starts without the owner's explicit permission.
