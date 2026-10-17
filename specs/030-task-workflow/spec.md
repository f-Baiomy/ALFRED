# Feature Specification: Task workflow - a board from words or a work item, defined with cards, triaged, verified and listened to, closed

**Feature Branch**: `030-task-workflow`
**Created**: 2026-10-17
**Status**: Draft - agreed in the grilling session of 2026-10-17 (28 decisions, listed under Clarifications)
**Mock**: [mock-workflow.html](mock-workflow.html)

## Overview

A task is a board (specs/027). Today a board can be made from the user's words or from an Azure work item, but the
road from there to a tested, closed task is not one flow: `/alfred-setup` refuses a board that already exists, the
seed sees only the titles of an item's children, every item type is treated the same, the cards come only after
testing, the skills take a cycle where the user thinks of a board, and nothing brings later changes in Azure back
onto the board.

This feature makes it one flow of seven stages, the same for every task:

1. **Board** - made in the UI (New board, from words or a work item). Nothing runs by itself.
2. **Define** - `/alfred-setup <board>` (terminal, or the board chat while `/alfred-live` runs) reads the item, its
   parents up to the Epic and every child in full, and drafts the brief, spec, test steps, data, decisions, evidence
   AND the cards - a BUG card with a scenario to reproduce for each Bug, a TASK card for each Task and for each
   Acceptance item no task covers. One "Save all". All cards land in the Inbox, before any code.
3. **Triage** - `/alfred-triage` with a code look per card: where the change goes, which team owns it, whether it is
   already written. The user decides each card.
4. **Code** - the user writes it.
5. **Verify** - `/alfred-verify` reads the code and moves cards through the agreed questions ("Record as fixed?" with
   an Azure update offer), checks every Acceptance item per layer, re-tests Fixed cards from the live calls.
6. **Test** - `/alfred-listen` reads new calls: ticks steps, re-tests Fixed cards, opens Inbox cards for what fails.
7. **Close** - `/alfred-report` and one consent bundle for the main item.

Azure stays in step: a Refresh brings new comments, states, bugs and tasks on the main item, its children and its
parents back to the board as proposals; a card with no Azure item finds the one a tester uploaded later, or proposes
creating one.

## Clarifications

### Session 2026-10-17

- Q: How is the define draft approved? → A: One draft (brief, spec, steps, data, decisions, evidence, cards), one "Save all"; the user may change or drop parts first.
- Q: Azure markers when a card is made from a child item? → A: Link the card to its item only; no consent bundle at define.
- Q: An Acceptance item no Azure Task covers? → A: A TASK card with no Azure item.
- Q: A child already Done/Closed in Azure? → A: Still a card, marked "Azure says done"; triage or verify checks the code.
- Q: Where does the child-type mapping live? → A: In the skills' shared `rules.md`; no new setting.
- Q: How deep is the tree read? → A: Children in full (fields and comments), grandchildren as titles, parents as a chain up to the Epic (description and acceptance). Long parts paged, never cut.
- Q: How is a board named in a command? → A: `AB#<id>` (the board whose main is that item), its name or name prefix, or its id. Bare `#n` is always a card number.
- Q: ▶ Start? → A: Kept as the one-click "New board + ask Claude in chat". New board posts nothing.
- Q: Verify finds a To do card's code written? → A: It asks "Record as fixed?" with three options - Record as fixed / Record + prepare Azure update / Not yet.
- Q: Which Azure state does that bundle propose? → A: Resolved for a Bug, Closed for a Task; the closest allowed state when that one is not allowed, saying so.
- Q: Listen and To do cards? → A: Listen re-tests Fixed cards only.
- Q: A board from an Epic? → A: One board with a section per Feature; Claude offers one board per Feature, the user opens them.
- Q: Where is the stage computed? → A: In the backend, one rule shared by `task_context` NEXT, the board's stage strip and `/alfred-guide`.
- Q: `/alfred-setup` on a board already defined? → A: It works as `/alfred-spec` does: before → after for the description, brief, requirements, test steps and data, with warnings; each removal (an Acceptance item, a step, a card to close) asked one at a time - as board questions when asked from the board, as terminal questions when asked from the terminal; new cards added, duplicates linked, closes proposed.
- Q: Refreshing from Azure? → A: A "↻ Refresh from Azure" button updates the copies with no Claude and shows "N changes"; re-running `/alfred-setup <board>` reads only what changed and proposes the board edits.
- Q: The business closed, removed or postponed the main item? → A: A banner and proposals (close the open cards as Not in this flow, stop listen, keep the board for reference); the user decides.
- Q: Close? → A: `/alfred-report` proposes one bundle for the main item - a summary comment, its state, masked evidence.
- Q: The card's Azure button, card linked to an item? → A: Two paths: write it yourself (comment, state, a field; sent at once with the user's token), or "Draft with Claude" (a bundle the user approves).
- Q: The card's Azure button, card with no item? → A: Look for a related item first; link it if found (on the user's click), else propose a bundle that creates a Bug or Task under the main item and links it.
- Q: When is a related item looked for? → A: On the card button, on every Refresh (code only, "N possible matches") and on the setup re-run (Claude judges).
- Q: Linked at once? → A: Proposed on the card - Link / Not this one / Show others; "Not this one" is remembered.
- Q: How is "related" decided? → A: Code finds candidates (the main's tree, open, Bug/Task, words, endpoint, created after the card); Claude judges them against the card's repro and steps and says why. No model when there is no candidate.
- Q: Triage code look for planned cards? → A: Where the change goes, which team owns it, whether it is already written - with "Record as fixed?" next to To do / another team / close.
- Q: Where does the work live? → A: This spec, `specs/030-task-workflow`, branch `030-task-workflow`.
- Q: Build order? → A: Backend → skills → frontend → docs and end-to-end; one commit per phase, full suites at the end of each.
- Q: End-to-end check? → A: On AB#61813 in Docker; every Azure bundle left waiting, never approved.

## User Scenarios & Testing

### User Story 1 - Define a board from a work item, with cards, before any code (Priority: P1)

The user makes a board from User Story AB#61813 in the Team tab (New board). The board opens empty with "Not defined
yet". They run `/alfred-setup AB#61813` in the terminal. Claude reads the story, its Feature and Epic, and its seven
children in full, and shows one draft: brief, 12 Acceptance items, 11 test steps, data, 3 decisions, evidence, and 5
cards (2 TASK from the Task children, 1 BUG with a reproduce scenario from Bug AB#61844, 1 TASK for an Acceptance item
no task covers, 1 QUESTION). The user says "Save all".

**Independent test**: with the fake tracker holding a story, a parent chain and one child of each type, `/alfred-setup`
on the board yields the draft above; after "Save all" the board has the brief, spec, evidence and five Inbox cards,
each child-made card linked to its item, and no bundle waits.

**Acceptance Scenarios**:
1. **Given** a board made with New board, **When** it opens, **Then** nothing was posted to its chat and a "Not defined yet" banner shows the terminal command and an "Ask Claude in chat" button, greyed out until a live runner answers the board.
2. **Given** a story with a Bug child, **When** setup drafts, **Then** the BUG card holds the steps to reproduce, expected and actual, the re-test check by the calls, the Acceptance item it breaks and a link to the Bug item.
3. **Given** an Acceptance item no Task child covers, **When** setup drafts, **Then** a TASK card with no Azure item is drafted for it.
4. **Given** a Task child that Azure shows Closed, **When** setup drafts, **Then** its card is marked "Azure says done".
5. **Given** an Investigation and a Meeting child, **When** setup drafts, **Then** their findings land under Decisions and Data, each line naming its source item.
6. **Given** the draft, **When** the user says "Save all", **Then** everything is saved in one go, the cards are in the Inbox, and no consent bundle was prepared.
7. **Given** a board made from the user's words (no item), **When** setup runs, **Then** it drafts from the words as today, with cards only for what the words name.

### User Story 2 - Every skill takes the board (Priority: P1)

The user types `/alfred-verify AB#61813`, `/alfred-listen AB#61813`, `/alfred-live AB#61813`, the board's name, or
its id. Each finds the board; listen finds the board's recording cycle, or says to press Record and waits.
`task_context` accepts all of these.

**Acceptance Scenarios**:
1. **Given** a board id, **When** `task_context` is called with it, **Then** it answers with that board (today: "No session cycle with id").
2. **Given** `AB#61813`, **When** any task tool or skill gets it, **Then** it resolves to the board whose main item is AB#61813; none → "no board has AB#61813 as its main - make one in the Team tab".
3. **Given** `#60`, **When** a skill gets it, **Then** it is card 60, never a board.
4. **Given** a board whose cycle does not record, **When** `/alfred-listen` starts, **Then** it says "press Record on the Cycles tab" and waits for calls.

### User Story 3 - Triage planned cards with a look at the code (Priority: P1)

`/alfred-triage AB#61813` goes through the Inbox. For each define card Claude says where the change goes (file or
class), which team owns it, and whether it is already written, and recommends To do / another team / close /
"Record as fixed?". The user decides each card.

**Acceptance Scenarios**:
1. **Given** a TASK card whose code is already on the task branch, **When** triage reaches it, **Then** it shows the file:line and commit and offers "Record as fixed?".
2. **Given** a card owned by another team, **When** triage reaches it, **Then** it recommends To do for that team, with the reason.

### User Story 4 - Verify moves cards from the code, and offers the Azure update (Priority: P1)

After coding, `/alfred-verify AB#61813` finds the code of To do cards and asks on each card: Record as fixed / Record
+ prepare Azure update / Not yet. The second records the fix and prepares a bundle - a comment naming the commit and
branch, and the state Resolved (Bug) or Closed (Task) - that waits for the user's approval.

**Acceptance Scenarios**:
1. **Given** a To do card linked to a Bug item with its code written, **When** verify runs, **Then** the card holds the three-option question.
2. **Given** the answer "Record + prepare Azure update", **When** it is recorded, **Then** the card is Fixed and a bundle waits with the comment and state Resolved.
3. **Given** a process where Closed is not an allowed Task state, **When** the bundle is prepared, **Then** the closest allowed state is proposed and the bundle says so.
4. **Given** a To do card with no code yet, **When** verify runs, **Then** it stays in To do with "not found in …".

### User Story 5 - Re-define and refresh from Azure (Priority: P2)

The tester adds a comment and a new Bug under AB#61813 in Azure; the business postpones a Task. The user presses
"↻ Refresh from Azure" on the board: the copies update and the board shows "3 changes · 1 possible match". They run
`/alfred-setup AB#61813` again: Claude shows the brief and spec before → after, asks one question per removal, adds a
BUG card for the new Bug (or links the card it matches), and proposes closing the postponed Task's card.

**Acceptance Scenarios**:
1. **Given** a defined board, **When** setup runs again, **Then** it never overwrites: it shows before → after and saves only on yes.
2. **Given** an Acceptance item the new text drops, **When** setup asks, **Then** it asks once for that item, naming the marks and cards it loses - in the board chat when asked from the board, in the terminal when asked there.
3. **Given** the Refresh button, **When** pressed, **Then** the main's tree is read live, the copies are updated, the changes are counted, and no Claude run starts.
4. **Given** the main item Closed or Removed in Azure, **When** the board refreshes, **Then** a banner names who and when, and setup proposes closing the open cards as Not in this flow and stopping listen; nothing closes without the user.

### User Story 6 - A card finds its Azure item, or proposes one (Priority: P2)

Listen opened BUG #72 two days ago. Yesterday QC uploaded Bug AB#61902 for the same problem. On Refresh the card
shows "Looks like AB#61902 (Bug, by QC, 1 day ago) - same endpoint and repro" with Link / Not this one / Show others.
A card with no match offers, on its Azure button, a bundle that creates the Bug under the main item.

**Acceptance Scenarios**:
1. **Given** an unlinked card and a new open Bug in the main's tree with matching words or endpoint, **When** Refresh runs, **Then** the card shows the candidate (code only); Claude's reason is added on the setup re-run or the card button.
2. **Given** "Not this one", **When** later refreshes run, **Then** that item is never proposed for that card again.
3. **Given** "Link", **When** clicked, **Then** the card is linked to the item and Alfred keeps its copy; no bundle is made.
4. **Given** no candidate, **When** the card button is pressed, **Then** "Create in Azure" prepares a bundle with the card's title, text and masked evidence, under the main item; after approval the new item is linked to the card.

### User Story 7 - The card's Azure button, for a linked card (Priority: P2)

On a card linked to AB#61844 the user opens "Azure ▾": write a comment / change the state / edit a field themselves
(sent at once with their token, like the item drawer), or "Draft with Claude", which posts to the board chat and comes
back as a bundle on the card.

### User Story 8 - The stage strip and close (Priority: P3)

The board header shows the seven stages with the current one marked and its exact command (copy). When every card is
Verified or closed, `/alfred-report` proposes one bundle for the main item.

### Edge Cases

- A board with no main item (made from words): no Refresh, no match search; the card Azure button offers "Create in Azure" under no parent, or "Link an item" by search.
- An item that is the main of another board: setup names that board and stops (one main per item, as today).
- A child the token cannot read: listed by id under Context, "not readable with the current token".
- An Epic with many Features: Features read in full, their Stories as titles; one section per Feature; offers of Feature boards never open one.
- TOKEN_MISSING anywhere: say "Enter your token in the Team tab first" and stop; Refresh shows the same in the UI.
- Two unlinked cards match one new item: both show it; linking one removes it from the other's proposals.
- The tunnel: Refresh and the card's direct writes are refused through it (TeamTunnelGuard), as every live read is.

## Requirements

### Functional Requirements

- **FR-001**: New board MUST NOT post anything to the board's chat. ▶ Start keeps posting the waiting `/alfred-setup` message.
- **FR-002**: A board with no brief MUST show a "Not defined yet" banner with the command `/alfred-setup <board>` (copy) and "Ask Claude in chat", enabled only while a live runner answers the board.
- **FR-003**: The seed MUST return the item's children in full (mapped fields, repro, acceptance, state, comments), grandchildren as titles, and the parent chain up to the top (each parent's description and acceptance), each long part paged by `part` + `offset`, never cut.
- **FR-004**: `/alfred-setup` MUST accept a board (`AB#<id>`, name or prefix, id), a work item (`AB#<id>`, `<conn>/<id>`, URL) or words, and fill an existing board instead of refusing it.
- **FR-005**: The define draft MUST include cards: BUG per Bug child (with reproduce scenario, expected/actual, re-test check, Acceptance item, link), TASK per Task child, TASK per Acceptance item no task covers, QUESTION per unclear point; each drafted line names its source item.
- **FR-006**: A card drafted from an item MUST be linked to it on save, with no consent bundle; a child closed in Azure MUST be marked "Azure says done".
- **FR-007**: The child-type rules (Bug, Task, Investigation/Spike, Meeting, Test Case, other) and the item-type rules (Epic, Feature/User Story, Task, Bug, words) MUST be written once in `skills/_shared/rules.md`.
- **FR-008**: `/alfred-setup` on a defined board MUST show before → after per part, ask each removal one at a time (board questions when started from the board, terminal questions when started from the terminal), add only new cards, link duplicates, and propose closes.
- **FR-009**: `task_context` and every task tool and skill MUST accept `AB#<id>`, a board name or prefix, a board id, or a cycle id or name; bare `#n` MUST stay a card number.
- **FR-010**: `/alfred-listen <board>` MUST listen to the board's recording cycle, or say to press Record and wait.
- **FR-011**: `/alfred-triage` MUST give each planned card where the change goes, its owning team and whether it is already written, with "Record as fixed?" among the options.
- **FR-012**: `/alfred-verify` MUST ask "Record as fixed?" with Record as fixed / Record + prepare Azure update / Not yet on a To do card whose code is written; the update bundle holds a comment (commit, branch) and the state Resolved (Bug) / Closed (Task) or the closest allowed one, said so.
- **FR-013**: The board's stage MUST be computed once in the backend and served to `task_context` NEXT, the stage strip and `/alfred-guide`.
- **FR-014**: "↻ Refresh from Azure" MUST read the main's tree live, update the copies, and report changes (new/changed items, comments, states) and possible matches, with no Claude run.
- **FR-015**: Unlinked cards MUST get candidate items from code (the main's tree, open Bug/Task, word or endpoint overlap, created after the card); "Not this one" MUST be stored and never proposed again for that card.
- **FR-016**: The card's Azure button MUST offer, for a linked card, the user's own direct comment / state / field write and "Draft with Claude"; for an unlinked card, the candidates first, then "Create in Azure" (a bundle under the main item that links the new item on approval).
- **FR-017**: A main item Closed, Removed or postponed (moved out of the iteration) in Azure MUST show a banner; the setup re-run proposes closing open cards and stopping listen.
- **FR-018**: `/alfred-report` MUST propose one bundle for the main item when every card is Verified or closed.
- **FR-019**: `/alfred-guide` MUST show the seven stages and the full table of skills; stale paths (Session Cycles → Record, Brief tab) MUST be replaced by the board page's tabs.
- **FR-020**: Nothing in this feature writes to Azure without the user's approval, except the user's own direct write from the card's Azure panel.

### Key Entities

- **Seed** (extended): adds `children` (full) and `parents` (chain) parts to the existing purpose / steps / acceptance / context / parentAcceptance.
- **Board stage**: NEW · DEFINE · TRIAGE · CODE · VERIFY · TEST · CLOSE, with the next command - computed, not stored.
- **Item match**: card × item candidate with its source (words, endpoint), state PROPOSED / LINKED / REJECTED; REJECTED kept.
- **Refresh result**: per board - changed items with before → after, new items, new comments, main state change, possible matches.

## Success Criteria

- **SC-001**: From a story with 7 children, setup's draft holds every child's contribution (no child reduced to its title) and is saved with one "Save all".
- **SC-002**: The four skills (setup, verify, listen, live) and `task_context` all accept `AB#61813`, the board name and the board id; 0 "No session cycle" errors for a board.
- **SC-003**: A bug uploaded to Azure after its card exists is proposed on that card at the next Refresh.
- **SC-004**: The end-to-end run on AB#61813 goes through all seven stages with 0 Azure writes approved by Claude.
- **SC-005**: Re-running setup on an unchanged board proposes no change.

## Assumptions

- Azure DevOps only (the one connector); the rules are written so a later connector maps its types onto the same rules.
- "Postponed" means the item left its iteration or moved to a state its process names as removed/deferred.
- The live runner's board-chat routing (specs/022, 027) answers the "Ask Claude in chat" message as it answers Start today.

## Out of Scope

- Claude creating or moving Azure items without a bundle.
- Automatic Claude runs triggered by the service hook (it only marks the board changed).
- Listen asking "Record as fixed?" on To do cards.
