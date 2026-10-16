# Feature Specification: Boards rework and Team tab

**Feature Branch**: `027-boards-and-team`
**Created**: 2026-10-17
**Status**: Draft
**Input**: User description: "Connect the board with the team's board (Azure DevOps / Jira / ClickUp…): list its boards, work items, links, changes and assignees, its squads and members, in a tab of their own. Later, open an Alfred board for an item and run /alfred-setup with its data. Before that, rework the boards: a board can hold many cycles, a cycle can belong to many boards, and a cycle only stores calls." Settled in a grilling session; the interactive mock is [mock.html](mock.html).

## Overview

Two parts, built in this order:

1. **Boards rework.** Today there is one board per project, and a session cycle is the task: it holds the brief, spec files, requirements, chat and the calls. After this feature, a **board is the task** (brief, spec files, Acceptance items, test plan, chat, Inbox, cards) and a **cycle only stores calls** (a recording or a re-test). Boards and cycles are many-to-many, across projects. Each project keeps one default board.
2. **Team tab.** A new top-level tab that reads the team's work tracker (Azure DevOps first) through a provider-neutral connector: boards and sprints, work items of every type (custom ones included), their links, full change history, assignees, squads and members, and a feed of changes. From any work item the user can open an Alfred board, which runs /alfred-setup with the item's data.

**Terms used throughout**: *board* = the task; *cycle* = a stored recording or re-test of calls; *Acceptance items* = a board's checkable requirements (shown on the "Requirements" tab); *work item* = an item in the team's tracker; *connection* = one tracker organization Alfred reads.

## Clarifications

### Session 2026-10-17

- Q: What is a board's lifecycle? → A: Open / Done / Archived. The user marks Done; Archived hides it from the picker (one click shows it); archived boards keep everything, judge no new calls, and can be reopened.
- Q: Who may create, relate, archive or delete boards? → A: The same as board writes today: allowed where board writes are allowed (the edit rule; Docker allows), never through the tunnel; Claude within its limits.
- Q: Which boards judge live calls that are in no cycle? → A: Every Open board of that project, each by its own items; a recording only stores the call in its cycle.
- Q: Whose is the Changes feed's "since last look" / "mark seen"? → A: Shared for everyone: one seen mark per connection kept in Alfred; marking seen clears "new" for every viewer.
- Q: How large is the Team cache designed for? → A: Up to 20,000 items per connection; filters and search answer in under 1 s; Refresh fetches only items changed since the last fetch.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A board is the task, cycles only hold calls (Priority: P1)

The user works on a task ("Refund by voucher") on its own board. The board holds the brief, spec files, Acceptance items, test plan, chat and cards. The user records calls in cycles and relates each cycle to the board; the board's requirements are judged on the calls of every related cycle. A re-test is another cycle related to the same board.

**Why this priority**: Every other part (shared cycles, Azure Start, the Team tab's link to Alfred) needs the board to be the task.

**Independent Test**: Create a board, relate two cycles, and check that the Task tab shows the brief and requirements judged on both cycles' calls, and that the Session Cycles tab shows neither a brief nor a chat for a cycle.

**Acceptance Scenarios**:

1. **Given** a project, **When** the user creates a named board with a first recording, **Then** the board exists with an empty brief, a new recording cycle is related to it, and the board picker lists it under "Task boards".
2. **Given** a board with two related cycles, **When** the user opens its Task tab, **Then** each Acceptance item shows a verdict from the calls of either cycle, with the cycle it came from.
3. **Given** a cycle, **When** the user opens it in Session Cycles, **Then** it shows its calls and its related boards, and no brief, spec, requirements or chat.
4. **Given** a board, **When** the user relates or unrelates a cycle (or another board), **Then** the change is shown at once and recorded in the board's activity; unrelating never deletes the cycle or its calls.

---

### User Story 2 - Cards have one home and show where they belong (Priority: P1)

A card has exactly one home board (its status, history and Inbox), one origin cycle (where it was found) and any number of related cycles. A board shows its own cards and, unless the user switches to "Own only", cards from its related cycles and related boards, marked as homed elsewhere. Card numbers stay unique per project.

**Why this priority**: Without a clear home, the same finding would appear as different cards on different boards.

**Independent Test**: Relate one cycle to two boards, add a card on board A from that cycle, and check that board B shows it dashed with "home A", with the same status, and that "Own only" hides it.

**Acceptance Scenarios**:

1. **Given** a card homed on board A from a cycle also related to board B, **When** the user opens board B, **Then** the card shows as related with its home named, and its status is the same on both boards.
2. **Given** a card, **When** the user (or Claude) moves its home to another board, **Then** its number and history stay the same and both boards' activity records the move.
3. **Given** a card, **When** the user relates it to another cycle (a re-test, the same bug seen again), **Then** boards related to that cycle also show it.

---

### User Story 3 - One cycle shared by several boards (Priority: P1)

One recording can serve several tasks: a sprint board and a task board both relate "rec 14 Oct". Each board judges every call by its own Acceptance items. Listening to the cycle happens once for all its boards, never twice.

**Why this priority**: Many-to-many is the core of the rework; without these rules shared cycles produce duplicate cards and mixed verdicts.

**Independent Test**: Relate one cycle to two boards with different Acceptance items, open the cycle's calls, and check the per-board verdict columns and the "for this board" filter; run one listen and check that no finding is created twice.

**Acceptance Scenarios**:

1. **Given** a cycle related to boards A and B, **When** the user opens its calls, **Then** each call shows A's verdicts and B's verdicts side by side, and a call no board's items name shows none.
2. **Given** the same cycle, **When** the user filters "for board A", **Then** only calls A's items name or A's cards mention are shown; "All" shows every call.
3. **Given** a listen on a shared cycle, **When** a finding matches an existing card, **Then** it is added as evidence to that card, not a new card.
4. **Given** a listen on a shared cycle, **When** a new finding touches only board A's items, **Then** its card is homed on A; **When** it touches the items of several boards, **Then** Claude asks the user in a board chat which board is its home, and the others show it as related.
5. **Given** a cycle recording for board A, **When** the user starts a recording from board B of the same project, **Then** Alfred offers to relate the running cycle to B too, or to start a new cycle that pauses the running one.
6. **Given** a cycle recording for board A, **When** the user starts or resumes another cycle related to a board of the same project from the Session Cycles tab (or Claude does through its tools), **Then** Alfred offers to pause the running one, or cancels.

---

### User Story 4 - Chat lives on boards, answered by the board's terminal (Priority: P2)

Each board has one chat. A cycle has none. A board's chat and its cards' comments are answered by the terminal session that ran /alfred-live for that board; without one, the project's live runner answers; with neither, messages wait.

**Why this priority**: Keeps today's live-answer behaviour after the cycle stops being the task.

**Independent Test**: Run /alfred-live for a board, send a message in its chat, and check it goes WAITING → TAKEN → ANSWERED by that terminal; stop it and check the project runner answers; stop both and check the message waits.

**Acceptance Scenarios**:

1. **Given** /alfred-live is running for board A, **When** the user writes in A's chat, **Then** that terminal session answers and the header says "Answered by your terminal".
2. **Given** no /alfred-live for board A, **When** the user writes, **Then** the project's live runner answers.
3. **Given** no runner at all, **When** the user writes, **Then** the message stays WAITING with "Terminal offline · messages wait" and can be cancelled.
4. **Given** Claude related a cycle or moved a card from the chat, **When** the user presses Undo on that record, **Then** the change is reversed and the activity shows it undone.

---

### User Story 5 - Existing data moves to the new model on first start (Priority: P1)

On the first start after the update, each project gets a default board holding its cards and its project chat. Each cycle that had a brief becomes a board of the same name, with its brief, spec files, requirements, chat history and cards, related to that cycle. Cycles without a brief relate to the project's default board.

**Why this priority**: Users must not lose or re-enter any task.

**Independent Test**: Start the new version on a copy of an existing database and compare: every card, brief, spec file, requirement and chat message is reachable on exactly one board.

**Acceptance Scenarios**:

1. **Given** a cycle with a brief and cards, **When** Alfred starts for the first time after the update, **Then** a board named after the cycle holds them, shows "Migrated from cycle …", and relates to the cycle.
2. **Given** a cycle without a brief, **When** migration runs, **Then** it relates to the project's default board and its cards stay on that board.
3. **Given** migration has run, **When** Alfred restarts, **Then** nothing is migrated twice.

---

### User Story 6 - Deleting a cycle keeps what boards still mention (Priority: P2)

When the user deletes a cycle, calls, statements and log lines that a card on any board mentions move into a new "kept from <cycle>" cycle related to that board, one per board. Everything nobody mentions is deleted. The dialog lists both before the user confirms.

**Why this priority**: A cycle shared by many boards must not silently take another board's evidence with it.

**Independent Test**: Delete a cycle mentioned by cards on two boards and check two "kept from" cycles exist, each holding only its board's mentioned data, and the rest is gone.

**Acceptance Scenarios**:

1. **Given** a cycle whose calls cards on boards A and B mention, **When** the user opens Delete, **Then** the dialog lists, per board, the calls, statements and log lines that will be kept, and the number of calls that will be deleted.
2. **Given** the user confirms, **Then** each of A and B relates to its own "kept from <cycle>" cycle, and cards whose origin was the deleted cycle stay on their home boards marked "origin deleted".

---

### User Story 7 - The Team tab shows the team's work (Priority: P2)

The user connects Alfred to an Azure DevOps organization with a personal access token kept in their browser. The Team tab lists, for the projects and teams the user chose, the boards and sprints, the work items of every type (custom types such as Meeting and Thread too) with all their fields and links, each item's full change history, the squads and their members, and a feed of changes filtered by squad or person.

**Why this priority**: The view itself is useful before any link to Alfred boards exists.

**Independent Test**: Add a connection, paste a token, pick a project, and check that items, an item's history, squads and the changes feed appear; remove the token and check the shared cache is still shown with a notice.

**Acceptance Scenarios**:

1. **Given** a connection with a valid token, **When** the user presses Refresh, **Then** items for the chosen scope are fetched, shown with "fetched just now", and kept in a cache.
2. **Given** a selected work item, **When** the user opens it, **Then** all its fields, its links (parent, children, related, pull requests) and its full revision history (who changed which field, when) are shown; history is fetched on open.
3. **Given** no token in this browser, **When** the user opens the Team tab, **Then** the shared cache that any viewer fetched is shown with who fetched it and when, and Refresh asks for a token.
4. **Given** an expired token, **When** the user presses Refresh, **Then** an error says the token expired or lacks rights, and the cache stays visible.
5. **Given** the Squads view, **When** the user maps a squad to one of the project's Alfred teams, **Then** the mapping is saved; squads and members themselves are read-only.
6. **Given** the Changes view, **When** the user filters by squad and marks all seen, **Then** only that squad's changes show and the "new" marks clear.

---

### User Story 8 - Open a board from a work item (Priority: P2)

From any work item the user opens an Alfred board: ▶ Start in the Team tab, by asking Claude in a terminal, or by writing in any board chat ("open a board for AB#4533"). Alfred posts /alfred-setup to the target board's chat; the board's runner creates a board named after the item, seeds its brief and spec from the item's data, relates it to the board the item maps to, and starts a first recording cycle. Only the user opens boards; Claude may suggest one.

**Why this priority**: This is the vision of the feature, and it needs Stories 1 and 7 first.

**Independent Test**: Map a sprint to a board, press Start on a bug in that sprint, and check the new board's brief, Acceptance items, linked item chip, related board and recording cycle; press it again and check it opens the existing board.

**Acceptance Scenarios**:

1. **Given** a work item whose sprint or area is mapped, **When** the user presses ▶ Start, **Then** the button shows "waiting for runner", then "/alfred-setup running…", then "Open task ▾", and the new board exists.
2. **Given** an item whose area is not mapped, **When** the user presses Start, **Then** Alfred asks once for the Alfred project and an optional board to relate to, and remembers the answer.
3. **Given** an item that already has a board, **When** the user opens its menu, **Then** it offers Open board, New re-test cycle and /alfred-resume, and never opens a second board.
4. **Given** a Feature or Epic, **When** the user starts it, **Then** one board is made with its child items listed as steps, each with its own Start.
5. **Given** a board chat, **When** the user writes "open a board for AB#id", **Then** a board is opened for that item and related back to that chat's board.
6. **Given** Refresh brings in a new item, **When** a runner is active on its mapped board, **Then** Claude posts a suggestion with Yes / No in that board's chat; nothing opens until the user says yes.
7. **Given** the item's runner is offline, **When** the user presses Start, **Then** the request waits and can be cancelled.

---

### User Story 9 - A board notices when its work item changed (Priority: P3)

When the linked work item changes after setup (acceptance criteria edited, for example), the board's Task tab shows "Azure changed" with the change. The user reviews Claude's before/after through /alfred-spec and saves it, or dismisses it.

**Why this priority**: Keeps tasks honest with the tracker, but the board is usable without it.

**Independent Test**: Edit an item's acceptance criteria in Azure, Refresh, and check the badge on its board, the before/after, and that saving changes the Acceptance item.

**Acceptance Scenarios**:

1. **Given** a linked item whose acceptance criteria changed, **When** the user opens the board's Task tab, **Then** "Azure changed" shows who changed what and when.
2. **Given** the review, **When** the user saves, **Then** the Acceptance item changes and is judged again; **When** the user dismisses, **Then** nothing changes.

---

### Edge Cases

- A cycle related to no board is listed under "Not on any board" in Session Cycles, and can be related or deleted.
- Deleting a board keeps every related cycle and its calls; the board's cards move to the project's default board. A default board cannot be deleted.
- A card homed on board A shown on board B through a shared cycle keeps one status; changing it on B changes it on A.
- Two listens on the same shared cycle never both add a card for one finding.
- A finding that names no board's items is homed on the board the listen was started for.
- Unmapped work item on Start: asked once; "Remember" saves the mapping.
- A work item's board was deleted: the item shows Start again.
- "Open a board for AB#id" from a chat or the terminal for an item never fetched: Claude says to Refresh the Team tab first and opens nothing.
- A board opened without a token lists its item's attachments as links until someone with a token presses "Fetch attachments".
- A connector without a capability (for example no sprints or no history): the views that need it are hidden or say so; nothing breaks.
- Viewing through the tunnel: Team settings are read-only; the personal token still works because it lives in the browser.
- Import of an export made before this feature: lands on the project's default board.
- An older Alfred importing a new export: skips the new board records and reads the rest.
- The connector's cache grows: it has its own share of the storage budget; items linked to a board are never evicted.

## Requirements *(mandatory)*

### Functional Requirements

**Boards and cycles**

- **FR-001**: A board MUST be a named entity with a project. Each project MUST have exactly one default board, which cannot be deleted.
- **FR-001a**: A board MUST have a state: Open, Done or Archived, set only by the user. Archived boards MUST be hidden from the picker unless the user chooses "Show archived", MUST keep all their data, MUST NOT judge new calls or receive new findings, and MUST be reopenable. A default board cannot be archived.
- **FR-001b**: Creating, renaming, relating, archiving and deleting boards MUST follow the existing board-write access rule: allowed where board writes are allowed, never through the tunnel. Claude MAY relate and move homes; opening boards follows FR-040; it MUST NOT archive or delete boards.
- **FR-002**: A board MUST hold the brief, spec files, Acceptance items, test plan, chat, Inbox, activity and cards. A cycle MUST hold only recorded calls (with their statements, Redis commands and log lines) and MUST NOT hold a brief, spec, requirements or chat.
- **FR-003**: Boards and cycles MUST be related many-to-many, across projects. Boards MAY also be related to other boards.
- **FR-004**: The user and Claude MUST both be able to relate and unrelate cycles and boards. Every change MUST be recorded in the board's activity; Claude's changes MUST carry Undo.
- **FR-005**: A board's Acceptance items MUST be judged on the calls of every related cycle, and on every live call of the board's project while the board is Open. Each board MUST judge only by its own items, and keep its verdicts apart from other boards'. A recording only adds the stored copy of a call to its cycle; it does not decide which boards judge it.
- **FR-006**: The Board tab MUST offer a board picker grouping default boards and task boards, a strip of related cycles and boards, and an "Own + related / Own only" filter.
- **FR-007**: The Session Cycles tab MUST group cycles by board (a cycle on several boards appears under each, with the other boards named), show a "Not on any board" group, and offer "Group by: None".
- **FR-008**: Only one cycle MUST record per project at a time, whichever way the recording is started (a board, the Session Cycles tab, or Claude's tools). A cycle's projects are the projects of the boards it is related to. Starting or resuming a recording while another cycle of the same project records MUST offer: relate the running cycle to this board (when started from a board), or start/resume this one and pause the running one.
- **FR-009**: A cycle's call view MUST show each related board's verdicts per call and a "for this board" filter (calls the board's items name or its cards mention).

**Cards**

- **FR-010**: Every card MUST have one home board, one origin cycle and zero or more related cycles. Card numbers MUST stay unique per project and unchanged when the home changes.
- **FR-011**: A board MUST show its own cards and, unless "Own only" is chosen, cards whose origin or related cycles are related to it and cards homed on boards related to it, marked with their home.
- **FR-012**: The user and Claude MUST both be able to move a card's home; the move MUST be recorded on both boards.
- **FR-013**: Claude's new findings MUST land in the Inbox of their home board. Claude's existing limits (Inbox only for new cards, allowed moves, no closing) MUST apply per board.
- **FR-014**: One listen MUST cover a whole cycle for all its boards. A finding that matches an existing card MUST be added to it as evidence. A new finding MUST be homed on the board whose items it touches; if several boards' items, Claude MUST ask the user in a board chat and wait.

**Chat**

- **FR-015**: Chat MUST exist on boards only. A board's chat and its cards' comments MUST be answered by the terminal session that ran /alfred-live for that board, else by the project's live runner, else MUST wait (cancellable).
- **FR-016**: The old fork path for older runners MUST keep working and MUST be marked in code and docs for later removal.

**Cycle and board deletion**

- **FR-017**: Deleting a cycle MUST move every call, statement and log line that cards on a board mention into a new "kept from <cycle>" cycle related to that board (one per board), and MUST delete the rest. The dialog MUST list both before confirming. Cards whose origin was the deleted cycle MUST stay, marked "origin deleted". Calls a card mentions, and their statements, Redis commands and log lines, MUST stay out of the storage limits while the mention exists, so a rescued call never loses its captured data later.
- **FR-018**: Deleting a board MUST keep its related cycles and move its cards to the project's default board.

**Migration and compatibility**

- **FR-019**: On first start after the update, Alfred MUST migrate once: each project gets a default board holding its cards and project chat; each cycle with a brief becomes a board with its brief, spec files, requirements, chat history and cards, related to that cycle; other cycles relate to the default board.
- **FR-020**: Exports MUST add board, board-cycle and board-board records and a snapshot of each linked work item. An export without board records MUST import onto the project's default board. No new values may be added to enums an older Alfred reads.
- **FR-021**: Claude's tools MUST take an optional board (default: the board of the given cycle when exactly one, else the project's default board), and MUST add listing boards, relating cycles/boards, moving a card's home and opening a board (the last only when the user asks).

**Team connections**

- **FR-022**: The Team feature MUST be built on a provider-neutral connector contract: one model (item, type, field, revision, link, person, squad, board, sprint, connection), one cache, one UI. Adding a provider MUST NOT change the core, its storage or its UI shell.
- **FR-023**: A connector MUST declare its capabilities (boards, sprints, squads, revisions, attachments, custom types; later item writing and webhooks). Views that need a missing capability MUST be hidden or say so.
- **FR-024**: Azure DevOps MUST be the first connector. Jira and ClickUp MUST appear as "not installed".
- **FR-025**: Alfred MUST support several connections at once (provider + organization URL + chosen projects/teams), shown together and filterable by connection.
- **FR-026**: The Team feature MUST be read-only toward the provider in this version.
- **FR-027**: Each user's personal access token MUST be kept only in that user's browser and sent with each request; it MUST never be written to disk, the database, exports or logs, and never be given to Claude.
- **FR-028**: Data MUST be fetched only on demand (opening the tab, Refresh, opening an item's history), never on a timer. Fetched data MUST go into one shared cache that every viewer sees, labelled with who fetched it and when.
- **FR-029**: Only the projects and teams chosen in Settings MUST be fetched. After the first fetch, Refresh MUST fetch only items changed since the last fetch.
- **FR-030**: The Team tab MUST offer Work items (filter by type, squad, state, assignee, text), Boards & sprints, Squads & members, and Changes (feed since last look, filter by squad or person, mark seen). The seen mark MUST be one per connection, kept in Alfred and shared by every viewer; marking seen clears "new" for everyone. It MUST use neutral words (Item, Sprint, Squad…) with the provider's word as a hint.
- **FR-031**: An item MUST show all its fields, its links, and on open its full revision history.
- **FR-032**: A squad MAY be mapped to one Alfred team of a project; squads and members MUST stay read-only.
- **FR-033**: Team settings (connections, scope, mappings, field maps) MUST follow the usual settings edit rule; through the tunnel they MUST be read-only.
- **FR-034**: The cache MUST have its own share of the storage budget; oldest revisions MUST be evicted first; items linked to a board MUST be kept.

**Opening a board from a work item**

- **FR-035**: Every work item of every type MUST offer Start. Start MUST post /alfred-setup for the item as a waiting message to the target board's chat; the board's runner MUST create a board named after the item, a first recording cycle, and relate the board to the mapped board.
- **FR-036**: The target MUST come from a mapping of provider sprint, squad, area or project to an Alfred project and optional board. An unmapped item MUST ask once and offer to remember.
- **FR-037**: The new board MUST be seeded from the item's title, description, acceptance criteria, repro steps, comments, linked items (with the parent's acceptance criteria), attachments as spec files, and assignee, squad and sprint. Settings MUST let the user map any field of a type to Purpose, Steps or Acceptance; unmapped fields MUST go into a Context section.
- **FR-037a**: Attachments MUST be fetched by Alfred with the token of the user who pressed Start. When a board is opened without a token (from a chat or the terminal), its attachments MUST be listed by name and link, with "Fetch attachments" for a later viewer who has a token. Claude never fetches them.
- **FR-038**: A Feature or Epic MUST make one board, listing its children as steps each with its own Start.
- **FR-039**: An item that already has a board MUST offer Open board, New re-test cycle and /alfred-resume instead of Start.
- **FR-040**: Only the user opens boards: from the Team tab, by asking Claude, or from any board chat (the new board relates back to that chat's board). Claude MUST NOT open a board on its own; it MAY suggest one in a board chat with Yes / No. When Claude opens a board, the request MUST name the user's asking message (a board chat message by the user within the last 30 minutes, checked by Alfred) or the terminal (recorded in the board's activity as "opened at your request in the terminal"); otherwise Alfred MUST refuse it.
- **FR-041**: When a linked item changes after setup, its board MUST show "<provider> changed" (e.g. "Azure changed") with the change, and offer a before/after review through /alfred-spec that only the user saves.
- **FR-042**: Board texts MUST accept work item mentions shown as chips with the item's current state, or its snapshot when the cache or token is missing.

### Key Entities

- **Board**: a task. Name, project, default flag, state (Open / Done / Archived); owns brief, spec files, Acceptance items, test plan, chat, Inbox, activity; may link to one work item.
- **Cycle**: recorded calls (recording or re-test); recording / paused state. A cycle has no project of its own: its projects are those of the boards it is related to, and it may hold calls of several projects.
- **Board–Cycle relation**: many-to-many; a cycle may serve several boards.
- **Board–Board relation**: a board shows related boards' cards.
- **Card**: number unique per project; one home board, one origin cycle, related cycles, mentions.
- **Connection**: provider, organization URL, chosen projects/teams, capabilities.
- **Work item**: id, type (custom too), title, state, assignee, squad, sprint, area, fields, links, revisions, fetched by/at, provider raw data.
- **Squad / Person**: provider teams and members; a squad may map to an Alfred team.
- **Mapping**: provider sprint/squad/area/project to Alfred project and optional board.
- **Field map**: per item type, provider field to Purpose / Steps / Acceptance / Context.
- **Board link**: board to work item, with a snapshot and the last revision seen.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After migration, 100% of existing cards, briefs, spec files, requirements and chat messages are reachable on exactly one board, and a second start migrates nothing.
- **SC-002**: A user creates a board, relates two cycles and sees requirement verdicts from both in under 1 minute.
- **SC-003**: On a cycle shared by two boards, one listen produces zero duplicate cards for one finding.
- **SC-004**: Deleting a cycle mentioned by two boards keeps 100% of the mentioned calls, statements and log lines, and removes all others.
- **SC-005**: From pressing Start on a mapped work item, the user reaches a seeded board with a recording cycle in under 2 minutes, with no data typed by hand.
- **SC-006**: Opening a work item shows its full history within 3 seconds for items with up to 100 revisions.
- **SC-006a**: With 20,000 cached items in one connection, Work items filters and search show results in under 1 second, and a Refresh with 50 changed items finishes in under 10 seconds.
- **SC-007**: A personal token never appears in any file, database, export or log Alfred writes (checked by a test).
- **SC-008**: Adding a second provider needs no change to the core, its storage or the Team tab shell (checked by an architecture test that core never references a provider).
- **SC-009**: No list in the Team tab or the reworked board refreshes on a timer.

## Assumptions

- Azure DevOps is reached with a personal access token with read scopes (work items, project and team, graph); per-user OAuth sign-in is out of scope.
- Webhooks from the provider and writing back to the provider are out of scope for this version; the contracts leave room for both.
- Teams stay per project; squads only map to them.
- The tunnel stays read-only for settings; the browser-held token works everywhere.
- Users accept that the shared cache shows every viewer items any token fetched, even ones their own token cannot open.
- Card numbers, mention formats and the existing card statuses do not change.
- Claude's free relating and home moves are accepted without a consent step, because every change is recorded and can be undone.
- The interactive mock ([mock.html](mock.html)) is the reference for screens and flows.
