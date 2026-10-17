# Feature Specification: Team trackers live, linked to Alfred boards and cards

**Feature Branch**: `028-team-live-search`
**Created**: 2026-10-17
**Status**: Draft
**Input**: Replace the Team tab's fetch-everything cache with live search; link whatever is on Azure DevOps to whatever is on an Alfred board (a board's main item and its tree, cards and their bugs and tasks); people as pills with "me"; writes back to Azure only with the user's approval; a cycle holds only calls; the MCP tools and the /alfred-* skills follow. Builds on specs/027-boards-and-team.
**Mock**: [mock.html](mock.html) - the "Every decision" screen maps each decision to the screen that shows it.

## Clarifications

### Session 2026-10-17

- Q: Where does the token live for live search and the MCP? → A: In backend memory, one per connection, 8 hours; the last one entered wins; its owner is shown; never on disk or in logs; a restart or Forget clears it.
- Q: What is still cached? → A: Only the filter lists (teams, iterations, types and states, people). Work items are never stored from a search.
- Q: Search form? → A: Button-driven, 50 per page, sort; text, type, state, team/area, iteration (@current), assigned (me), changed within, tags, parent; Open only by default; Azure full-text search with a WIQL `CONTAINS` fallback.
- Q: How many items per board? → A: Many; one is the main item (★). An item can sit on several boards.
- Q: Saved searches on a board? → A: No (watch rules cover "new things arriving").
- Q: MCP tools? → A: The full set (see FR-090..), every write through the user's consent card.
- Q: Writes to Azure? → A: Comments and state changes (and later, by the same consent, creating items, links, tags, attachments).
- Q: What goes away? → A: The Changes tab, refresh suggestions and reconcile.
- Q: Consent for Claude's writes? → A: A consent card in Alfred; the user's own writes from the Team tab go straight through.
- Q: Token owner when many people use one Alfred? → A: One per connection; the last entered is live.
- Q: When are a board's items fetched again? → A: On opening Related items (at most once a minute) and on Refresh.
- Q: How does a comment look in Azure? → A: It ends with "via Alfred: board <name>" and a link.
- Q: Start and mappings? → A: Kept.
- Q: Teams / Iterations views? → A: Kept as browsers over the cached lists; a click runs a search.
- Q: Upgrade? → A: Drop everything (old cache and old board links), nothing migrated.
- Q: Board links on live results? → A: Always shown, from Alfred's own links matched by connection + id.
- Q: What is saved? → A: Only the board's main item and items linked to cards, each in full (every field, description, repro, acceptance, comments, relations, attachments list, history of syncs). Every other item in the tree is a reference (id, type, title, state), opened live on click and never kept.
- Q: Tree? → A: The main's ancestors and all its descendants, plus one hop of other links (Related, Duplicate, Tested by…); siblings listed, not in the tree.
- Q: Tree on sync? → A: Follow it: new children appear, moved ones are marked "left the tree" and kept until unlinked; the diff lists each.
- Q: Tree view? → A: Tree and By type toggle.
- Q: Main item? → A: Any type, picked by the user; always one once an item is linked (the first linked, or Start's); changeable; it re-roots the tree and seeds the Task tab (brief and Acceptance items), with a change in Azure offering an update.
- Q: Cycles? → A: A cycle page shows calls only, with links to its boards; the cycles list groups by board including "Not on a board"; a new cycle is made for a board.
- Q: Related items tab? → A: Last tab of the board; grouped by the tracker's type, custom types included.
- Q: People? → A: Pills with a hover card (name, email, id, teams, projects, items, boards); "me" = the owner of the live token (automatic) and "This is me" overrides it for the browser and the MCP; @person mentions everywhere; a card owner field; Mine = assigned, created, changed, @mentioned in Azure, followed, boards whose items are mine, cards I own, cards that mention me.
- Q: Cards and Azure items? → A: Many to many. Pill in the description plus a "Linked in Azure" strip. From a card: link an existing item or create one in Azure. Azure markers on approval: hyperlink to the card, comment, tag `alfred`.
- Q: How do new Azure items arrive? → A: Tree sync, board watch rules, an Azure service hook, by hand, and the MCP. They wait in an "Incoming from Azure" lane (no card yet) for New card / Link to card… / Ignore; Claude proposes one with a reason; close matches are suggested first.
- Q: Hook? → A: One signed route through the tunnel; pings carry ids only; ids wait while no token is live.
- Q: Card ↔ Azure state? → A: Verified/Done prepares a state move and evidence comment for approval; an Azure close/reopen shows a badge and a proposal on the card.
- Q: New card from an item? → A: Kind mapped from the type (Bug→BUG, Task/Story/PBI→TASK, Issue/Impediment→QUESTION, others→NOTE, editable); Features and Epics stay in Related items.
- Q: Comments? → A: Azure comments show on the card; the user's go out only with "Also post to Azure"; Claude's through consent.
- Q: Watch rules? → A: In board settings, built from the Team filters, run on board open, Refresh, hook ping and MCP.
- Q: Card link address? → A: A "public Alfred address" setting; unset = comments only.
- Q: Evidence to Azure? → A: Flexible, from chat: state + findings + exported calls; one consent card with a tick per step; exports redacted by default, unmasked only by the user's own tick.
- Q: Unlink or close as Not in this flow? → A: Propose cleaning up Azure (hyperlink, tag, short comment).
- Q: Add from a search row? → A: New card on board…, Link to card…, Related items only, Start board.
- Q: MCP reads? → A: Any item live, references included (team_item, team_tree with live expand, team_items_live, team_attachment).
- Q: Skills? → A: Every /alfred-* skill and the shared rules updated; a new /alfred-team; skills change with the tools.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Search the tracker live (Priority: P1)

The user enters their personal access token once, searches Azure with filters and text, and sees which results are already on Alfred boards. Nothing from the search is stored.

**Why this priority**: The fetch-everything cache failed on a real organisation (VS402337, 7,392 items, 6,892 change rows) and is the base every other story uses.

**Independent Test**: With a fake Azure connector: enter a token, search "refund" with Type=Bug and Open only, page to 2, open a result's details; check no item row exists in `teamboards.db` and a linked result shows its board badge.

**Acceptance Scenarios**:

1. **Given** no token in memory, **When** the user opens the Team tab, **Then** search is disabled and a token field explains it is kept in memory for 8 hours and never on disk.
2. **Given** a token entered, **When** Alfred asks Azure who owns it, **Then** the tab shows "token live · <name> · <time left>" and that person becomes "me" in this browser.
3. **Given** filters and text, **When** the user presses Search, **Then** the first 50 open results come back live with total count, sort and paging; switching off Open only includes Closed and Removed states.
4. **Given** Azure full-text search is off for the organisation, **When** searching words, **Then** titles are matched with WIQL `CONTAINS` and a banner says so.
5. **Given** a result linked to a board, **When** any later search returns it, **Then** it shows the board badge (★ when it is that board's main) and "Azure changed since the board's copy" when its rev is newer.
6. **Given** Azure refuses a call, **Then** the error names the call and Azure's own message.
7. **Given** the backend restarts or the user presses Forget token, **Then** the token is gone and searches (UI and MCP) ask for it again.
8. **Given** the upgrade from 027, **Then** the old item cache, revisions, changes feed and board links are deleted and a one-time notice says so.

---

### User Story 2 - A board's main item and its tree (Priority: P1)

A board is about one Azure item - the main (★), of any type. Related items (the board's last tab) shows the main's ancestors, all its descendants and its direct links as a tree or by type. Only the main is saved in full; the others are references opened live.

**Why this priority**: It is how a board "knows" its work in Azure and what /alfred-setup and the Task tab build on.

**Independent Test**: Start a board from a Story with two Tasks and a parent Feature; check the main's full copy is saved, the tree has 4 references, a click on a Task fetches it live, Make main on the Feature re-roots the tree, and a sync after a new child appears marks it "new on sync".

**Acceptance Scenarios**:

1. **Given** a board with no item, **When** the user links the first item (or Start uses one), **Then** it becomes the main; a board with linked items always has exactly one main.
2. **Given** a main, **Then** Related items lists its ancestors (context), every descendant, and one hop of its Related / Duplicate / Tested-by / Predecessor / Successor links, each as a reference (id, type, title, state), with Tree / By type views; siblings are listed outside the tree with "+ Add".
3. **Given** the user picks another item as main (any type), **Then** the tree re-roots, the new main is saved in full, the old one becomes a reference unless a card links it, and the Task tab offers to re-seed the brief and Acceptance items.
4. **Given** a click on a reference, **Then** its full details are fetched live and nothing is kept; with no token live it says to enter one.
5. **Given** the user opens Related items or presses Refresh with a token live, **Then** the main and card-linked items are synced (at most once a minute on open); each sync is kept in the item's history.
6. **Given** a sync, **Then** a field-by-field diff (state, text fields, tags, comments, attachments, children, tree moves) is shown against the saved copy; "Keep Azure's version" makes it the new copy.
7. **Given** a new child, **Then** it appears as "new on sync" and is offered in Incoming (US3); **Given** a moved or removed child, **Then** it is marked "left the tree" and kept until unlinked.
8. **Given** the main's acceptance criteria change in Azure, **Then** the board offers to update its Acceptance items, never silently.
9. **Given** Add by id or Azure URL, **Then** the item is added to the board (as a reference unless it becomes the main or is linked to a card).

---

### User Story 3 - Cards and Azure items (Priority: P1)

The user links Azure bugs and tasks to board cards (many to many): an Azure item arriving in Alfred becomes a card or joins an existing one, and an existing card can be linked to or create an Azure item.

**Why this priority**: The user's vision - "link whatever is on Azure to whatever is on my board".

**Independent Test**: A new Azure bug arrives through a watch rule; it waits in Incoming with "Looks like #35"; Claude proposes "link to #35"; the user accepts; #35's description gains the pill, its strip shows the Azure state, and the item's full copy is saved.

**Acceptance Scenarios**:

1. **Given** an Azure item arrives (tree sync, watch rule, hook, by hand, MCP), **Then** it waits in the board's "Incoming from Azure" lane - no card yet - with New card, Link to card… (close matches first, other boards too) and Ignore.
2. **Given** a close match (`board_similar`), **Then** the entry shows "Looks like #n (x %)" and Link to #n first.
3. **Given** Claude proposes (`team_propose_card`) New card or Link to #n with a reason, **Then** the proposal shows on the entry and in chat; nothing happens until the user accepts.
4. **Given** New card, **Then** an Inbox card is made with the kind mapped from the type (editable per type), the title copied, the description = the item's pill + Azure's description; Features and Epics never become cards.
5. **Given** a card linked to an item, **Then** the card description holds `@[workitem:<conn>/<id>|…]`, the card shows a "Linked in Azure" strip (item, Azure state, who changed it, sync state), and the item is saved in full.
6. **Given** a card, **When** the user chooses Link existing (search from the card) or Create in Azure (type, title, area, iteration, assignee, description from the card), **Then** a consent card shows the Azure writes (hyperlink to the card, comment, tag `alfred`, and the new item for Create); nothing reaches Azure before approval.
7. **Given** one item linked to several cards (any boards), **Then** each card shows it; unlinking one keeps the others.
8. **Given** Azure comments on a linked item, **Then** they show in the card's activity marked "from Azure".
9. **Given** the Azure item is closed or reopened by someone else, **Then** the card shows a badge and Alfred proposes the card move; the user decides.
10. **Given** a search row, **Then** Add ▾ offers New card on board…, Link to card…, Related items only, Start board.
11. **Given** Ignore, **Then** the item stays out of Incoming until it changes in Azure.

---

### User Story 4 - Telling Azure (Priority: P2)

From the card or the chat ("update the bug on Azure, attach the calls and comment what you found"), the user or Claude prepares Azure writes; the user approves them in one consent card.

**Why this priority**: Closes the loop - a bug verified in Alfred is reported in Azure without copying by hand.

**Independent Test**: Verify card #35; a "Tell Azure" card appears with a state move, an evidence comment and a redacted .html export; untick the attachment, approve; the fake connector receives the state change and the comment in order and the card reports both results.

**Acceptance Scenarios**:

1. **Given** a card moves to Verified or Done, **Then** a Tell Azure card is prepared per linked item: a state move from the item's process (e.g. Resolved/Closed), an evidence comment (call summary, card link), optional attachments.
2. **Given** a bundle, **Then** each step has a tick; Approve sends the ticked steps in order as the live token's owner and reports each result; Edit changes text; Reject drops it.
3. **Given** an attachment export of calls, **Then** Alfred's redaction rules are applied by default, the card shows size and a preview, and sending unmasked needs the user's own tick on that file.
4. **Given** the user's own comment on a card, **When** "Also post to Azure" is ticked, **Then** it goes to Azure immediately (no consent card); Claude's comments never go without one.
5. **Given** the user changes state or comments from the Team tab's item details, **Then** it goes to Azure at once.
6. **Given** any comment Alfred writes, **Then** it ends with "via Alfred: board <name>" and the card/board link (when the public address is set).
7. **Given** unlinking a card from an item, or closing the card as Not in this flow, **Then** Alfred proposes removing its hyperlink and tag (and a short comment); the user approves or skips.
8. **Given** no token live, **Then** approvals wait and say a token is needed; nothing is sent with another person's token.

---

### User Story 5 - Watch rules and the Azure hook (Priority: P2)

A board watches Azure for new things (e.g. "new bugs in Payments", "mine this sprint"). The rules run when the board opens, on Refresh, on a hook ping and from the MCP.

**Independent Test**: Add a rule "Type=Bug, Area=Payments"; open the board; a new matching bug lands in Incoming once; a second run adds nothing; a hook ping with the new id adds it without opening the board (token live) or queues the id (no token).

**Acceptance Scenarios**:

1. **Given** board settings, **Then** the user adds rules built from the Team search filters (or "+ Rule from the current search").
2. **Given** a run (board open, Refresh, hook, `team_watch_run`), **Then** new matches enter Incoming, each item once per board.
3. **Given** the hook is set up in Azure with the URL and secret, **When** Azure pings "work item created/updated", **Then** Alfred checks the secret, takes only the ids, fetches them with the live token and routes them to boards whose tree or rules cover them; others are ignored.
4. **Given** no token live, **Then** pinged ids wait (shown in Settings) and are fetched when a token is entered.
5. **Given** Settings, **Then** the user sees the hook URL, shows the secret once, rotates it, sees the last ping, sets the public Alfred address and edits the type → card kind map.

---

### User Story 6 - People and "me" (Priority: P2)

People are pills everywhere (Teams tab members, assignees, mentions, card owners) with a hover card; "me" drives "Mine" in search, the board and the MCP.

**Independent Test**: Enter a token; its owner becomes "me"; the Teams tab shows names, not ids; Mine returns the eight sources; mention @Test User A in a comment; mark another person "This is me" and see the MCP's `team_people` report it.

**Acceptance Scenarios**:

1. **Given** the Teams tab, **Then** members show as pills with names (never raw ids).
2. **Given** a pill, **When** clicked or hovered, **Then** a card shows name, email, Azure id, connection, teams, mapped Alfred projects, open items assigned (live), cards owned / mentioned, boards; with Search their items, Copy mention, This is me, Open in Azure.
3. **Given** a token entered, **Then** "me" is its owner (Azure connectionData), automatically; **Given** "This is me" on another pill, **Then** that person is "me" for this browser and the MCP until the token changes.
4. **Given** `@` in a card description, comment, brief, chat or checklist evidence, **Then** people can be picked and are stored as `@[person:<conn>/<id>|Name]`, indexed like other mentions.
5. **Given** a card, **Then** it has an optional owner (a person); Claude sets owners only on its own Inbox cards.
6. **Given** Mine, **Then** results combine: assigned to me, created by me, changed by me, @mentioned in Azure, items I follow (all live), boards whose items are mine, cards I own, cards that mention me (Alfred).

---

### User Story 7 - A cycle holds only calls (Priority: P1)

The session cycle page loses its Board and Task tabs; the cycles list groups by board with "Not on a board".

**Why this priority**: A visible contradiction of 027's model the user hit ("the session cycle has a board... that's wrong").

**Independent Test**: Open a cycle on one board: only calls, and a banner linking that board plus Add to a board. Open the cycles list grouped by board with six cycles on no board: they appear under "Not on a board".

**Acceptance Scenarios**:

1. **Given** a cycle page, **Then** it shows calls only and "Recorded for board X ↗ · also on Y ↗ · + Add to a board"; a cycle on no board says so.
2. **Given** the cycles list grouped by board, **Then** every cycle shows: under each board it is on and under "Not on a board"; none disappear.
3. **Given** + New Cycle, **Then** it asks which board it is for (default: the current board) or none.
4. **Given** a board, **Then** its Cycles tab lists the cycles recorded for it and offers Record a cycle.

---

### User Story 8 - Claude through the MCP (Priority: P2)

Claude searches, reads and links the tracker as strongly as the UI, proposes every write, and reads any item live, references included.

**Independent Test**: With the MCP against a test Alfred: `team_search mine=true`, `team_tree expand=Bug`, `team_items_live` of 50 ids, `team_propose_card`, `team_comment` (creates a consent card, not a write), `board_search mine=true`.

**Acceptance Scenarios**:

1. **Given** no token live, **Then** every team_* read answers "enter your token in the Team tab"; Claude never receives a token.
2. **Given** a read, **Then** team_item returns the full item live (parts by `include=`), with the saved copy and diff for a full copy; team_tree returns references and expands chosen ids or types live; team_items_live returns up to 200 items; team_attachment returns one attachment (size-capped).
3. **Given** a write tool (link, create, comment, move state, unlink, board link), **Then** it creates or extends a consent card and returns its id; nothing reaches Azure until the user approves.
4. **Given** `team_propose_card`, **Then** the proposal shows on the Incoming entry and in chat.
5. **Given** the removed tools (team_items, team_changes, team_squads), **Then** they no longer exist and the skills do not name them.

---

### User Story 9 - The skills follow (Priority: P3)

The 16 /alfred-* skills and the shared rules use the new model; a new /alfred-team covers the tracker side.

**Independent Test**: `pytest tests/python` passes (every tool a skill names exists); reading each skill shows the change listed on the mock's Skills screen.

**Acceptance Scenarios**:

1. **Given** the shared rules, **Then** they state the token rule, live reads, full copy vs reference, consent-only writes with no bodies/secrets, person mentions and "me", and Azure arrivals as proposals.
2. **Given** each skill, **Then** it carries the change on the Skills screen (setup: main + tree + seed + watch-rule proposal; triage: Incoming first; fix: reads card items; verify: Tell Azure bundle; sync: Azure catch-up; status: Incoming, consent waits, Azure changes, "on you"; live: Azure asks in chat; listen/review: propose links; spec: seed from main; resume: main + tree + diffs; report: Azure side; ask: live reads; guide: Team flow).
3. **Given** /alfred-team, **Then** it covers search (mine, filters, text), add/link/start, Incoming across boards, sync, Tell Azure bundles and watch rules - with only team_* and board_* tools.

### Edge Cases

- Two people enter tokens for one connection: the last one is live; the Team tab shows whose; writes go as that person.
- Token expires or is revoked mid-session: the next call gets TOKEN_REJECTED; the token is dropped from memory; consent cards wait.
- A tree past 200 references: Alfred asks before saving the rest of the references.
- An item linked to two cards on two boards closes in Azure: both cards get the badge and proposal.
- An item brought along as a reference is also linked to a card: it becomes a full copy; unlinking the card makes it a reference again.
- The main item is deleted in Azure: the board keeps its last copy, marked "deleted in Azure", and asks the user to pick a new main.
- Hook ping with a bad secret: 401, nothing queued, the attempt is counted in Settings.
- Hook ping for an item no board covers: ignored.
- A process with custom states: the state move lists the item type's own states.
- Azure throttles (429): Retry-After honoured once; then PROVIDER_BUSY with the wait.
- Export larger than Azure's attachment limit (130 MB): the step fails with the reason; others still send.
- Public address unset: no hyperlink; the comment names the card number.
- Mention of a person no longer in Azure: the pill shows the stored name, greyed.
- Importing a board .json from 027 (one item link, no main): the link becomes the main.

## Requirements *(mandatory)*

### Functional Requirements

**Token**
- **FR-001**: The token MUST be held only in backend memory per connection, for 8 hours from entry, and never written to disk, logs, exports or responses.
- **FR-002**: Entering a token MUST resolve its owner through Azure (connectionData) and show it; the last token entered for a connection replaces the previous.
- **FR-003**: A backend restart, Forget token, expiry, or a TOKEN_REJECTED answer MUST remove it.
- **FR-004**: Every Azure call (UI, MCP, sync, hook, consent execution) MUST use the token in memory; with none, it MUST fail with TOKEN_MISSING and a message to enter one.

**Search and cache**
- **FR-010**: Search MUST query Azure live and return 50 results per page with total, sort (last changed, id, priority) and paging.
- **FR-011**: Filters MUST include text, type, state, team/area, iteration (incl. @current), assigned (incl. me), created by, changed within, tags, parent, Open only (default on: leaves out Completed/Removed state categories).
- **FR-012**: Text MUST use Azure's full-text work item search; when unavailable, WIQL `CONTAINS` on titles, with a banner.
- **FR-013**: No search result MAY be stored. Only filter lists (teams + members, iterations, types + states, people, area paths) are cached, refreshed when the tab opens.
- **FR-014**: Results MUST show board badges from Alfred's links (connection + id), ★ for a board's main, and "changed since the board's copy" when the rev is newer.
- **FR-015**: Azure errors MUST name the call and carry Azure's message (no request data).
- **FR-016**: The Team tab MUST keep the Teams and Boards & Iterations browsers; clicking a team or iteration runs a search filtered to it.
- **FR-017**: Removed: the Changes tab, the changes feed, refresh suggestions, reconcile, the item/field/revision/change tables.
- **FR-018**: The upgrade MUST delete the old cache tables and old board links and show a one-time notice; nothing is migrated.
- **FR-019**: Item details in the Team tab MUST show fields, description, related tree, comments and history live, with state change and comment that go straight to Azure.

**Board related items**
- **FR-030**: A board MUST hold many Azure items with exactly one main once any item is linked (the first linked or Start's); the user can make any item the main.
- **FR-031**: The main and every card-linked item MUST be saved in full: all fields (custom included), description, repro, acceptance, comments, relations, attachments list, rev, and each sync.
- **FR-032**: The tree MUST be the main's ancestors, all its descendants and one hop of its other links, saved as references (id, type, title, state, relation, parent) refreshed on each sync.
- **FR-033**: Clicking a reference MUST fetch it live and keep nothing.
- **FR-034**: Related items MUST be the board's last tab, with Tree and By type views (custom types included), Open only and "Changed since last look" filters, Add by id or URL, Find in Team, Refresh all.
- **FR-035**: Opening Related items with a token live MUST sync the main and card-linked items at most once a minute; Refresh does it on demand.
- **FR-036**: A sync MUST produce a field-by-field diff against the saved copy; Keep Azure's version replaces it; the sync is recorded.
- **FR-037**: A sync MUST follow the tree: new descendants appear ("new on sync") and are offered to Incoming; moved/removed ones are marked "left the tree" and kept until unlinked.
- **FR-038**: Changing the main MUST re-root the tree, save the new main in full, demote the old one to a reference unless a card links it, and offer to re-seed the Task tab.
- **FR-039**: The main MUST seed the Task tab's brief and Acceptance items (description, acceptance criteria, children as steps); a later change in Azure MUST offer an update with before/after, never silently.
- **FR-040**: More than 200 references in one tree MUST ask before saving the rest.
- **FR-041**: One Azure item MAY sit on several boards (as main on one and reference or card item on others); each board keeps its own role for it. Unlinking the main needs a new main to be named first.

**Cards and Azure items**
- **FR-050**: Cards and Azure items MUST link many to many.
- **FR-051**: Linking MUST insert the item's pill in the card description and show a "Linked in Azure" strip (item, Azure state and who changed it, sync state, Sync, Link another, Create in Azure); clicking the pill opens the saved copy.
- **FR-052**: From a card, the user MUST be able to link an existing item (searching Azure) or create a Bug/Task in Azure (type, title, area, iteration, assignee, description from the card).
- **FR-053**: Linking or creating MUST propose the Azure markers - hyperlink to the card (when the public address is set), a comment, the tag `alfred` - in a consent card.
- **FR-054**: New Azure items MUST arrive in an "Incoming from Azure" lane of the board (no card yet) from tree sync, watch rules, the hook, by hand and the MCP, each once per board.
- **FR-055**: Each Incoming entry MUST offer New card, Link to card… (close matches first, then any card on any board), Ignore; a close match (`board_similar`) shows "Looks like #n (x %)".
- **FR-056**: New card MUST map the kind from the type (Bug→BUG, Task/User Story/PBI→TASK, Issue/Impediment→QUESTION, others→NOTE; editable per type); Features and Epics never become cards.
- **FR-057**: Ignored items MUST stay out of Incoming until they change in Azure.
- **FR-058**: Azure comments of a linked item MUST show in the card's activity marked "from Azure".
- **FR-059**: An Azure close or reopen of a linked item MUST put a badge on the card and propose the card move.
- **FR-060**: Search rows MUST offer Add ▾: New card on board…, Link to card…, Related items only, Start board.
- **FR-061**: A card MUST have an optional owner (a person).

**Writes to Azure**
- **FR-070**: Every write prepared by Claude, and every Azure marker, MUST be a step in a consent card; the user's own direct actions (Team tab state/comment, "Also post to Azure") go at once.
- **FR-071**: A consent card MUST list its steps (state move, comment text, attachments, link, tag, create, remove) each with a tick, Edit and Reject; Approve sends ticked steps in order as the live token's owner and reports each result.
- **FR-072**: Verified or Done on a linked card MUST prepare a Tell Azure card per item (state from the item's process, evidence comment, optional attachments).
- **FR-073**: Exported attachments MUST have the redaction rules applied by default; sending unmasked MUST need the user's tick on that file; the card shows size and a preview.
- **FR-074**: Comments written by Alfred MUST end with "via Alfred: board <name>" and the link when the public address is set.
- **FR-075**: Unlinking a card from an item, or closing the card as Not in this flow, MUST propose removing Alfred's hyperlink and tag (tag only when no other card links the item) and an optional comment.
- **FR-076**: Without a live token, approved steps MUST wait and say so.

**Watch rules and hook**
- **FR-080**: A board MUST hold watch rules built from the Team filters, run on board open, Refresh, hook ping and `team_watch_run`.
- **FR-081**: The hook route MUST accept Azure "work item created/updated" pings through the tunnel, checked by a shared secret (basic auth), taking only ids.
- **FR-082**: Pinged ids MUST be fetched with the live token and routed to boards whose tree or rules cover them; others ignored; with no token, ids wait and are shown in Settings.
- **FR-083**: Settings MUST show the hook URL, the secret (shown once, rotate), last ping, waiting ids, the public Alfred address and the type → kind map.

**People**
- **FR-085**: People MUST render as pills everywhere (Teams members, assignees, created/changed by, mentions, owners), never as raw ids.
- **FR-086**: The pill card MUST show name, email, Azure id, connection, teams, mapped projects, assigned items (live), owned/mentioned cards, boards, with Search their items, Copy mention, This is me, Open in Azure.
- **FR-087**: "Me" MUST default to the live token's owner; "This is me" MUST override it for the browser and the MCP until the token changes.
- **FR-088**: `@[person:<conn>/<id>|Name]` mentions MUST be allowed and indexed in descriptions, comments, briefs, chat and checklist evidence.
- **FR-089**: Mine MUST combine the eight sources (assigned, created, changed, @mentioned in Azure, followed; boards whose items are mine, cards I own, cards that mention me), each counted.

**MCP**
- **FR-090**: Reads: `team_search` (filters, text, paging, mine), `team_query` (WIQL SELECT only), `team_item` (include parts; saved copy + diff for full copies), `team_tree` (references, live expand by ids/types, depth/type/state filters), `team_items_live` (≤ 200), `team_attachment` (size-capped), `team_people`, `team_board_items`, `team_card_items`, `team_incoming`, `team_watch_rules`.
- **FR-091**: Writes (each a consent card step): `team_board_link` / `team_board_unlink` (askedIn), `team_link_card` / `team_unlink_card`, `team_create_item`, `team_comment` (with attachments), `team_move_state`; proposals: `team_propose_card`; runs: `team_refresh_item`, `team_watch_run`.
- **FR-092**: `team_start` and `team_link` stay; `team_items`, `team_changes`, `team_squads` are removed.
- **FR-093**: `board_search mine=true` MUST include cards owned by or mentioning me and boards whose items are mine.

**Cycles**
- **FR-100**: The session cycle page MUST show calls only (no Board or Task tab) with links to its boards and Add to a board.
- **FR-101**: The cycles list grouped by board MUST show every cycle, with a "Not on a board" group.
- **FR-102**: + New Cycle MUST ask which board it is for (default the current board) or none.
- **FR-103**: The board MUST have a Cycles tab listing its cycles with Record a cycle.

**Skills and docs**
- **FR-110**: `skills/_shared/rules.md` and all 16 skills MUST be updated per the mock's Skills screen; a new `skills/alfred-team` MUST ship and install with the others.
- **FR-111**: Skills and tools MUST change together (`tests/python/test_alfred_skill.py`).
- **FR-112**: The board .json export MUST carry the board's related items (main full copy, references, card links, owner, incoming, watch rules), and import 027 files (one link → main).
- **FR-114**: Start board (/alfred-setup) and the sprint/squad/area/project mappings MUST keep working; the started item becomes the main.
- **FR-115**: Boards have no saved searches; watch rules are the way to be told of new items.
- **FR-113**: docs/team.md, docs/board.md, docs/mcp.md, docs/architecture.md, CLAUDE.md, AGENTS.md updated.

### Key Entities

- **Token in memory**: connection, token, owner (person), entered at, expires at. Never persisted.
- **Person**: connection, Azure id, display name, unique name (email), teams; cached list. "Me" per browser (local) and per connection for the MCP.
- **Board item**: board, connection, item id, role (main / reference / card-linked), relation to the main (ancestor, descendant, link kind, left-the-tree), type, title, state, rev, refreshed at.
- **Item copy**: connection, item id, rev, full JSON (fields, comments, relations, attachments list), saved at; history of syncs (rev, at, diff summary).
- **Card link**: card id, connection, item id, linked at, by, Azure markers written (hyperlink, tag, comment ids).
- **Incoming entry**: board, connection, item id, source (tree, rule, hook, hand, MCP), arrived at, close match, Claude proposal (action, card, reason), state (waiting, carded, linked, ignored at rev).
- **Watch rule**: board, name, filter set, last run, last result.
- **Consent card (Azure write bundle)**: id, board, card, origin (user / Claude + askedIn), steps (kind, payload, ticked, result), state (waiting, sending, done, rejected).
- **Hook settings**: secret (hashed), last ping, waiting ids, public Alfred address, type → kind map.
- **Card owner**: person reference on a card.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first search on an organisation with 20,000+ items returns in under 3 s; no item rows are written to disk by searching (checked by a test counting `teamboards.db` rows).
- **SC-002**: The token never appears on disk, in logs, in exports or in any response (test scans files, logs and responses after a session).
- **SC-003**: Opening Related items for a board with a 100-reference tree draws in under 1 s with no token live (references only).
- **SC-004**: Linking an Azure bug to a card takes at most 2 clicks from Incoming; nothing is written to Azure without an approval (test: the fake connector sees no write before Approve).
- **SC-005**: Every one of the 62 decisions on the mock's "Every decision" screen maps to at least one FR and one task.
- **SC-006**: The cycles list never hides a cycle (test with cycles on no board).
- **SC-007**: Exports sent to Azure carry no unmasked secret unless the user ticked "send unmasked" (test with a call carrying a token header).
- **SC-008**: The skills test passes and no skill names a removed tool.

## Assumptions

- Azure DevOps Services (cloud, REST 7.1) first; the SPI stays provider-neutral; Jira/ClickUp later.
- Token scope: Work Items (Read & Write), plus Identity (Read) for people and "me".
- The hook needs the tunnel (or LAN reachability); without it, everything else works.
- One Alfred instance per team; a team member's token is trusted as that person for writes.
- Old 027 Team data has no value worth migrating (user's choice).
