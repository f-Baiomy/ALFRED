# Feature Specification: Task Board

**Feature Branch**: `014-task-board`
**Created**: 2026-10-10
**Status**: Draft
**Input**: User description: "A task board that helps track bugs and tasks, and lets the user or the AI agent add notes, marked as urgent, bug, may cause a problem, etc. Change an item's status on the board; make it super user friendly. One board per project and one per session cycle, also visible on the session cycle itself. Mention calls, logs, statements, etc. in descriptions and comments, by hand or with a picker like the call picker, for everything. Comments record the steps taken, so the agent can continue the work and the user knows what happened to the task. Each session cycle has a description (what the cycle is for, which task, the specs) and uploaded spec files (.md or plain text) that can be viewed and mentioned. Inbox items can be marked as fine / not an issue or not in this flow. Export is required. Done cards are kept forever."

Mocks: [mock.html](mock.html) (first agreed version) and [mock-v2.html](mock-v2.html) (enhancements: live strip, triage mode, bulk actions, list view, acceptance checklist, keyboard).

## Clarifications

### Session 2026-10-10

- Q: Should the acceptance checklist ship with the board? → A: Yes, with the user's own marks only; Claude's marks and automatic cards on a fail come later.
- Q: Which statuses may Claude move a card to? → A: Only To do, In progress and Fixed; Verified, Done and Closed are the user's, and Claude proposes them in a comment.
- Q: When a session cycle is deleted, what happens to cards that mention its calls? → A: The mentions show as removed with a one-line summary; no copies are kept.
- Q: Can a card be deleted? → A: Yes, by the user after a confirmation; Claude can never delete.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Track work on a board (Priority: P1)

A developer opens the Board tab for a project and sees every card - bugs, tasks, notes and questions - in columns by status: Inbox, To do, In progress, Fixed, Verified, Done, and Closed. They add a card in one line from the quick-add bar, flag it (Urgent, Risk, Blocker, Affects project, Needs decision), and move it between columns by dragging, by its status menu, or by keyboard. Each card belongs to one project and may belong to one session cycle; the Cycle board shows only that cycle's cards.

**Why this priority**: Without the board nothing else in this feature has a place to live. It already gives value alone: a per-project list of what is broken and what is next, next to the recorded traffic.

**Independent Test**: Create cards of each kind in a project, flag them, move them through every column, switch between the Project and Cycle boards, reload the page, and confirm everything is as left.

**Acceptance Scenarios**:

1. **Given** the Board tab for project "odeysys", **When** the user types `bug! discount not saved #urgent` in quick add and presses Enter, **Then** a Bug card titled "discount not saved", flagged Urgent, appears in the Inbox.
2. **Given** a card in To do, **When** the user drags it to In progress, **Then** it shows in In progress for every open browser tab without a page reload, and its activity history records the move.
3. **Given** cards in two cycles, **When** the user switches to the Cycle board and picks one cycle, **Then** only that cycle's cards show; on the Project board each cycle card shows which cycle it belongs to.
4. **Given** a card in Done, **When** a year passes, **Then** the card is still there; Done and Closed cards are never deleted automatically.
5. **Given** many cards, **When** the user switches to List view, **Then** the same cards show as a dense table with kind, title, flags, status, cycle, author and age.

---

### User Story 2 - Sort the Inbox quickly (Priority: P1)

New findings, whether added by Claude or a person, land in the Inbox. The user sorts each one in a click or a key: **Fine - not an issue**, **Not in this flow**, or **To do**. A closed card moves to Closed with its resolution and an optional reason. A Triage mode shows Inbox cards one at a time. Several cards can be selected and closed together. Every close can be undone or reopened later.

**Why this priority**: The user's main fear is noise. If findings cannot be dismissed in seconds, the board fills with false alarms and stops being used.

**Independent Test**: Put five cards in the Inbox; close two as Fine with a reason, one as Not in this flow, accept one to To do, skip one in Triage mode; undo one close; reopen one closed card.

**Acceptance Scenarios**:

1. **Given** an Inbox card, **When** the user clicks "Fine", **Then** it moves to Closed labelled "Fine - not an issue", and a notice offers "Add reason" and "Undo" for several seconds.
2. **Given** an Inbox card, **When** the user chooses "Not in this flow", **Then** it moves to Closed labelled "Not in this flow" and its scope becomes Out of scope.
3. **Given** three Inbox cards, **When** the user opens Triage mode and presses F, N and T in turn, **Then** the cards are closed as Fine, closed as Not in this flow, and moved to To do, and Triage ends with "Inbox clear".
4. **Given** four selected cards, **When** the user picks "Fine" from the bulk bar, **Then** all four are closed as Fine in one action.
5. **Given** a closed card, **When** the user clicks "Reopen", **Then** it returns to the Inbox and its history records the reopen.
6. **Given** a new Inbox card that resembles a card already closed as Fine, **When** the board shows it, **Then** it carries a hint naming the earlier card and its resolution.

---

### User Story 3 - Mention evidence in text (Priority: P2)

In a card description, a comment, or a cycle brief, the user types `@` and a picker opens with tabs for Calls, Database statements, Log lines, Redis commands, Spec files, Code locations, and Cycles / spacers / cards / interception rules. They search, pick, and a chip is inserted. Mentions can also be typed by hand. Each chip shows a preview on hover (request line and status, the SQL with its values, the log line) and opens the item on click. The card's Linked list fills itself from its mentions; links can also be added without writing text.

**Why this priority**: Evidence is what turns a note into a bug someone can act on. It is second only because a board without mentions is still usable.

**Independent Test**: Write a description that mentions one call, one statement, one log line, one spec file section and one other card; confirm each chip previews and opens the right item and that all five appear in the Linked list.

**Acceptance Scenarios**:

1. **Given** a comment box, **When** the user types `@`, picks the Statements tab and selects statement #88, **Then** a statement chip is inserted at the cursor.
2. **Given** a mention chip of a call, **When** the user hovers it, **Then** a preview shows method, path, status, duration, direction and time.
3. **Given** a card mentioning a live call, **When** the storage limit deletes older calls, **Then** the mentioned call is not deleted and its mention still opens; **and given** the user deletes that call by hand, **Then** the mention shows as removed with its one-line summary.
4. **Given** a description mentioning `ODY-482-spec.md §Acceptance`, **When** the user clicks the chip, **Then** the spec file opens at that section.

---

### User Story 4 - Know what happened to a card (Priority: P2)

Every card has an activity history: comments by the user and by Claude, plus automatic entries for each change of status, kind, scope, flag, link, and spec file. Claude's comments always state what it did, what it found, what comes next, and, when a change touches shared code, its impact. A person or a new Claude session can read the history and carry on without asking anyone.

**Why this priority**: This is how work survives a closed session. It depends on cards existing (Story 1).

**Independent Test**: Change a card's status, scope and flags, post two comments, then open the card in a fresh session and confirm the full sequence shows in order with author and time.

**Acceptance Scenarios**:

1. **Given** a card, **When** the user changes its scope from Not decided to In scope, **Then** the history shows "You set scope Not decided -> In scope" with the time.
2. **Given** Claude investigated a card, **When** it posts its comment, **Then** the comment shows separate Did / Found / Next parts and the Claude badge.
3. **Given** a card with 50 history entries, **When** anyone opens it, **Then** all 50 show, oldest first, none summarised away.

---

### User Story 5 - Describe a cycle and attach its specs (Priority: P2)

Each session cycle has a brief: free text saying what the cycle is for, which task, the steps recorded, the rules in use, with mentions. The user uploads spec files (.md or plain text) or pastes text as a spec file. Specs open in a viewer that renders Markdown. Uploading a file with the same name replaces it. Spec files and their sections can be mentioned anywhere.

**Why this priority**: The brief gives every card and every reader the "why" of a recording, and gives Claude the spec to check against.

**Independent Test**: Write a brief for a cycle, upload one .md and one .txt spec, paste a third as text, view each, replace one, and mention a section of another from a card.

**Acceptance Scenarios**:

1. **Given** a cycle, **When** the user drops `ODY-482-spec.md` on the brief, **Then** the file appears in the spec list with size and time and opens rendered.
2. **Given** an existing `edge-cases.txt`, **When** the user uploads a new `edge-cases.txt`, **Then** the old content is replaced and the history of every card that mentions it records the replacement.
3. **Given** a file that is not .md or plain text, **When** the user drops it, **Then** it is refused with a message naming the accepted types.

---

### User Story 6 - See the board inside the session cycle (Priority: P2)

The session cycle page gets three tabs: Calls, Board, and Brief & specs. On the Calls tab, each call that a card mentions carries a small badge with the card number and state, and the Board tab's label shows how many cards are open. Right-clicking a call offers "Add to board", which creates an Inbox card linked to that call. The top-level Board tab stays a separate tab and shows the same cards.

**Why this priority**: Users work from the recording; the board must be where they already are.

**Independent Test**: In a cycle with three cards, open the cycle page, check badges on the mentioned calls, open a card from its badge, add a card from a call's menu, and see it on both the cycle page and the top-level Board tab.

**Acceptance Scenarios**:

1. **Given** card #7 mentions call POST /orders in cycle order-flow-3, **When** the user opens that cycle's Calls tab, **Then** the call row shows a badge "#7 bug" coloured by state, and clicking it opens card #7.
2. **Given** a call row, **When** the user picks "Add to board" from its menu, **Then** an Inbox card is created in this cycle with that call already linked.
3. **Given** a card changed on the top-level Board tab, **When** the cycle page is open elsewhere, **Then** the change shows there without a reload.

---

### User Story 7 - Claude works on the board (Priority: P3)

Through Alfred's existing connection for Claude, Claude can list and read cards with their full history, add cards (always into the Inbox), comment, update status and flags, and read cycle briefs and spec files. Before reporting a new finding, Claude reads the reasons on closed cards so it does not raise something the user has already dismissed. Claude may move a card only between To do, In progress and Fixed; it never sets scope, never moves a card to Verified, Done or Closed (it proposes those in a comment), and never deletes a card. While Claude is following a cycle, the board shows a live strip saying what it is watching and what it has done, with Pause and Stop.

**Why this priority**: This is the long-term goal (Claude as early tester and investigator), but it builds on every story above.

**Independent Test**: Ask Claude to review a recorded cycle against its spec; confirm its cards land in the Inbox with Claude's badge and mentions, its comments use Did / Found / Next, and it does not re-report an issue closed as Fine with a reason.

**Acceptance Scenarios**:

1. **Given** Claude finds a problem, **When** it adds a card, **Then** the card lands in the Inbox with the Claude badge, whatever status Claude asked for.
2. **Given** a card closed as "Fine - 401 on /health is expected", **When** Claude sees another 401 on /health, **Then** it does not add a new card for it.
3. **Given** Claude asks to set a card's scope, move it to Verified, Done or Closed, or delete it, **When** the request arrives, **Then** it is refused with a message that only the user decides that.
4. **Given** a card in In progress, **When** Claude moves it to Fixed and comments that the re-run passed, **Then** the move is accepted and the comment proposes Verified for the user to confirm.
5. **Given** Claude is following a cycle, **When** the user presses Pause on the live strip, **Then** the strip shows paused and Claude stops adding cards until resumed.

---

### User Story 8 - Export the board (Priority: P3)

The user exports the whole board, selected cards, or a cycle, as Markdown, HTML or JSON. In the existing cycle export, two checkboxes - "Include brief & specs" and "Include board cards" - are off by default and chosen per export. Exports contain every field and every history entry; nothing is shortened. The JSON export can be imported back.

**Why this priority**: Needed for the tester's report and for handing work over, but the board is useful before it exists.

**Independent Test**: Export a board with all kinds, flags, resolutions, mentions and long histories in each format; compare each to the board; import the JSON into a clean install and compare again.

**Acceptance Scenarios**:

1. **Given** a cycle with a brief, two spec files and five cards, **When** the user exports the cycle with both checkboxes ticked, **Then** the file contains the brief, both specs in full, and all five cards with full histories.
2. **Given** the same export with both checkboxes off, **When** the file is produced, **Then** it is identical to today's cycle export.
3. **Given** a board JSON export, **When** it is imported, **Then** cards, resolutions, reasons, mentions and histories match the original.

---

### User Story 9 - Acceptance checklist from the spec (Priority: P4)

In the cycle brief, the acceptance items of a spec file are shown as a checklist. The user marks each item pass, fail, or can't tell, and may attach evidence mentions to it. In this feature only the user marks items; Claude marking items and a fail mark creating an Inbox card belong to the later spec-verification feature, which builds on these marks without changing them.

**Why this priority**: First step toward checking a task against its spec. It is useful by hand now and is the base the automatic check will use.

**Independent Test**: Upload a spec with four acceptance items, mark each one with evidence, change one mark, reload, and confirm all marks and the change history are kept.

**Acceptance Scenarios**:

1. **Given** a spec with an "Acceptance" list, **When** the brief is shown, **Then** each item appears as a checklist row, unmarked until the user marks it.
2. **Given** a checklist row, **When** the user marks it fail and mentions statement #88, **Then** the row shows the fail mark with the statement chip.
3. **Given** a marked row, **When** the user changes the mark, **Then** the new mark shows and the change is recorded with its time.
4. **Given** the spec file is replaced and an item's text changes, **When** the brief is shown, **Then** that item's mark is cleared and the others keep theirs.

---

### Edge Cases

- A mentioned call reaches the storage limit: it is kept, like commented calls; cycle calls are already kept with the cycle. A call deleted by hand, and the statements and log lines tied to it, show as "removed" with their last known one-line summary.
- A session cycle is deleted: its cards stay on the project board, marked "cycle deleted"; its brief, spec files and checklist marks are deleted with it after the user confirms in the delete dialog; mentions of its calls, spacers and spec files show as removed with their one-line summary (no copies are kept).
- A card is deleted: its history and links go with it, and the calls it mentioned are no longer kept on its account; mentions of it elsewhere show as removed with its number and title.
- A mentioned card is merged or reopened: the mention still points at it and shows its current state.
- Two browser tabs edit the same card at once: the later save wins per field, and both edits are in the history.
- A spec file is very large (several MB of text): it is stored and exported in full; the viewer loads it without freezing the page.
- Quick add text has no kind prefix: the card becomes a Task.
- Claude is disconnected mid-work: cards and comments already saved stay; the live strip shows "Claude stopped" with the last check time.
- The board is opened read-only through the shared tunnel: it can be viewed and exported, not edited, matching the existing access rule for settings.
- Import of a JSON file with card numbers that already exist: imported cards get new numbers and their mentions are updated to match.

## Requirements *(mandatory)*

### Functional Requirements

**Cards and board**

- **FR-001**: The system MUST keep one board per project. Each card belongs to exactly one project and to at most one session cycle.
- **FR-002**: The system MUST offer a Project board (all of a project's cards) and a Cycle board (one cycle's cards) over the same cards, so a cycle card appears on both.
- **FR-003**: A card MUST have: number (unique in its project), kind (Bug, Task, Note, Question), title, description, status, flags, scope, author (user or Claude), created and last-changed time, cycle (optional), links, and activity history.
- **FR-004**: Statuses MUST be Inbox, To do, In progress, Fixed, Verified, Done, and Closed; a Closed card MUST carry one resolution: Fine - not an issue, Not in this flow, or Won't fix, and MAY carry a reason.
- **FR-005**: Flags MUST be Urgent, Risk, Blocker, Affects project, and Needs decision, in any combination.
- **FR-006**: Scope MUST be Not decided, In scope, or Out of scope; choosing "Not in this flow" MUST set scope to Out of scope.
- **FR-007**: Users MUST be able to change status by drag and drop, by the card's status menu, and by keyboard.
- **FR-008**: Users MUST be able to create a card from a one-line quick add, where a prefix sets the kind (`bug!`, `task!`, `note!`, `?`) and `#flag` words set flags.
- **FR-009**: Done and Closed cards MUST be kept forever unless the user deletes them. Only the user may delete a card, after a confirmation; deleting removes the card's history and links, releases the calls it kept, and mentions of it elsewhere show as removed.
- **FR-010**: The board MUST offer a List view with the same cards and filters as the board view.
- **FR-011**: The board MUST offer filters by kind, author (Claude or user), flag, scope not decided, and free-text search.
- **FR-012**: The board MUST show a progress summary: open, fixed or verifying, and done or closed counts, per project or per cycle.
- **FR-013**: A card unchanged for more than 5 days in an open status MUST show as stale.
- **FR-014**: Changes MUST appear in every open view of the board and cycle page without a reload and without the page asking for changes on a timer.

**Inbox triage**

- **FR-015**: Every Inbox card MUST offer one-click Fine, Not in this flow, and To do actions.
- **FR-016**: After a close, the system MUST offer Undo and Add reason for at least 6 seconds.
- **FR-017**: The system MUST offer a Triage mode that shows Inbox cards one at a time with Fine, Not in this flow, To do and Skip, by button or key, and a reason field.
- **FR-018**: Users MUST be able to select several cards and apply Fine, Not in this flow, To do or Mark urgent to all at once.
- **FR-019**: A closed card MUST offer Reopen, which returns it to the Inbox.
- **FR-020**: An Inbox card that resembles a closed card (same endpoint and same kind of problem) MUST show a hint naming that card and its resolution.

**Mentions and links**

- **FR-021**: Descriptions, comments and cycle briefs MUST support mentions of: calls (inbound and outbound), database statements, log lines, Redis commands, spec files and their sections, code locations, session cycles, spacers, other cards, and interception rules.
- **FR-022**: Typing `@` MUST open a picker with one tab per mention type, search, and keyboard selection; a mention MUST also be writable by hand in a documented text form.
- **FR-023**: A mention MUST render as a chip that previews the item on hover and opens it on click.
- **FR-024**: A card's Linked list MUST include every item its description and comments mention, plus links added directly.
- **FR-025**: A live call mentioned by any card MUST be kept out of the storage limits' deletions, the same way calls with comments and Relive sources are kept (Settings -> Storage rule), so the mention still opens. When the call is gone anyway (deleted by hand, or the keep rule switched off), the mention falls back to FR-026.
- **FR-026**: A mention whose item no longer exists MUST show as removed, with its last known one-line summary, and MUST NOT break the text around it.

**Activity history**

- **FR-027**: Every card MUST keep an activity history of comments and automatic entries for changes of status, kind, scope, flags, resolution, reason, links, and replaced spec files it mentions.
- **FR-028**: Each history entry MUST show author (user or Claude) and time; the history MUST show in full, oldest first.
- **FR-029**: Comments by Claude MUST separate what it did, what it found, what comes next, and, when relevant, impact on the rest of the project.

**Cycle brief and spec files**

- **FR-030**: Each session cycle MUST have a brief: free text with mentions and Markdown.
- **FR-031**: Users MUST be able to add spec files to a cycle by upload (.md, .txt) or by pasting text with a file name.
- **FR-032**: Spec files MUST open in a viewer that renders Markdown, and MUST be downloadable.
- **FR-033**: Adding a spec file with an existing name MUST replace its content (no older versions kept).
- **FR-034**: Deleting a session cycle MUST delete its brief, spec files and checklist marks, keep its cards on the project board marked "cycle deleted", and turn mentions of that cycle's calls, spacers and spec files into removed mentions with their one-line summary; no copies of cycle calls are kept.

**Board inside the session cycle**

- **FR-035**: The session cycle page MUST have Calls, Board, and Brief & specs tabs.
- **FR-036**: On the Calls tab, each call mentioned by a card MUST show a badge with card number and state; clicking it MUST open the card.
- **FR-037**: The Board tab's label MUST show how many of the cycle's cards are open. (A side panel of open cards beside the calls was built and then removed at the user's request, 2026-10-10: it narrowed the call list.)
- **FR-038**: A call's menu, in the cycle page and in Live Calls, MUST offer "Add to board", creating an Inbox card linked to that call.
- **FR-039**: The top-level Board tab MUST remain a separate tab alongside the cycle page view.

**Claude access**

- **FR-040**: Claude MUST be able to list cards, read a card with its full history, add a card, comment, change flags, change status within FR-042's limits, and read briefs, spec files and checklist marks, through Alfred's existing connection for Claude.
- **FR-041**: Cards added by Claude MUST land in the Inbox and carry the Claude badge.
- **FR-042**: Claude MAY move a card only to To do, In progress or Fixed. Claude MUST NOT set scope, move a card to Verified, Done or Closed, reopen a closed card, delete a card, or set checklist marks; such requests MUST be refused with a clear message. Claude proposes those changes in a comment.
- **FR-043**: Claude's tools MUST give it the reasons on closed cards of the project so it can avoid reporting dismissed issues again.
- **FR-044**: While Claude follows a cycle, the board MUST show a live strip with what it watches, calls checked, cards added, last check time, and Pause / Stop.

**Export**

- **FR-045**: Users MUST be able to export the whole board, selected cards, or one cycle's cards as Markdown, HTML and JSON.
- **FR-046**: The existing cycle export MUST offer "Include brief & specs" and "Include board cards", both off by default; with both off the output MUST be unchanged from today.
- **FR-047**: Exports MUST contain every field, every mention, every history entry and full spec file text; nothing may be shortened.
- **FR-048**: The JSON export MUST be importable, giving back the same cards, resolutions, reasons, mentions and histories.

**Access**

- **FR-049**: Editing the board MUST follow the same access rule as editing settings; viewers who may not edit see the board read-only and may export.

**Acceptance checklist**

- **FR-050**: The cycle brief MUST show a spec file's acceptance items as a checklist. The user MUST be able to mark each item pass, fail or can't tell and attach evidence mentions; each mark change MUST be recorded with its time.
- **FR-051**: When a spec file is replaced, an item whose text is unchanged MUST keep its mark; an item whose text changed or is new MUST start unmarked.
- **FR-052**: Marks by Claude and automatic Inbox cards from fail marks are out of scope for this feature; the stored marks MUST be usable by that later feature without migration of their meaning.

### Key Entities

- **Card**: one bug, task, note or question in a project. Number, kind, title, description, status, resolution and reason (when closed), flags, scope, author, times, optional cycle, links.
- **Activity entry**: one comment or one recorded change on a card. Author, time, kind (comment or change), text or old -> new values.
- **Mention / link**: a reference from a card, comment or brief to one item (call, statement, log line, Redis command, spec file section, code location, cycle, spacer, card, rule), with a one-line summary kept for when the item is gone.
- **Cycle brief**: the description of one session cycle.
- **Spec file**: a named .md or text document belonging to one cycle.
- **Checklist mark**: the pass / fail / can't-tell state of one acceptance item of one spec file, its evidence mentions, and the time of each change. Set by the user only in this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user creates a flagged card from quick add in under 5 seconds.
- **SC-002**: A user sorts 10 Inbox cards in Triage mode in under 60 seconds using only the keyboard.
- **SC-003**: Inserting a mention with the picker takes no more than 3 keystrokes after the search text for an item in the current cycle.
- **SC-004**: A change made in one tab is visible in every other open tab within 2 seconds.
- **SC-005**: A board of 2,000 cards opens and filters in under 1 second.
- **SC-006**: With the default storage rules, 100% of mentions to live calls still open after the storage limits have deleted older calls.
- **SC-007**: A person who did not do the work can state a card's current state, what was tried, and what is next from its history alone, without asking anyone, in usability review.
- **SC-008**: Exporting a board and importing the JSON gives back 100% of cards, histories and mentions, with no field shortened.
- **SC-009**: After the user closes an issue as Fine with a reason, Claude raises the same issue again in 0 of the next 10 recordings that show it.

## Assumptions

- Alfred has one user per install today; "author" is either the user or Claude. Assignees and multiple named users are out of scope until users exist.
- "Resembles a closed card" (FR-020) means the same endpoint and the same kind of signal (status code, error line, statement problem); a fuzzy match is acceptable.
- The board uses the same delivery-of-changes mechanism and access rule as the rest of Alfred.
- The documented hand-written mention form is plain text that survives copy and paste and export.
- Claude's Did / Found / Next format is enforced by the tool Claude uses to comment, not by checking the text.
- Spec files are text; images inside Markdown are out of scope for v1.
- Native install and Docker install both get the feature.
