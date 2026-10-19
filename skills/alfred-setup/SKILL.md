---
name: alfred-setup
description: Define a QA task with Alfred - check Alfred is connected and capturing (logs, SQL, Redis) for the project, then fill the task's board from a work item (AB#1234 - its parents and every child read in full) or the user's words - brief, spec with Acceptance items, evidence, test steps, data, decisions AND the cards (a BUG per Bug child with a reproduce scenario, a TASK per Task child and per uncovered Acceptance item) - shown as one draft and saved with one "Save all". Run again on a defined board it shows before → after, asks each removal, adds new cards and judges card matches after a Refresh from Azure. Use when the user starts or re-defines a task, says "set up a board for X", presses Start on a work item, or "/alfred-setup".
argument-hint: "[AB#1234 | <board name or id> | <conn>/1234 | project \"what the task is\"] [--dry]"
---

# Alfred setup - define the task

Read `rules.md` in this skill's folder first and follow it - §0a holds the stages, the item-type and child-type rules
this skill applies.

**Asking** (specs/037): every `board_ask` follows rules "Asking well" - the evidence goes in `details`; questions for someone outside Alfred go out as `board_questions_form`, and an answers file that comes back goes through `board_import_answers` (dry run first, apply on the user's yes).

## 1. Check Alfred

1. `list_projects` - Alfred answers and the project exists. No project given: if there is one, use it; if several,
   ask which (remember it for the rest of the session). If the repo's `CLAUDE.md` or `.alfred.json` names one, use that.
2. For the project, check inbound logging, ▤ log catching and ◆ database capture (and ⬢ Redis if the app uses it).
   If one is off, say what it means ("no log lines will be checked") and **ask** before turning it on
   (`set_inbound_logging`, `set_log_capture`, `set_db_capture`); report old → new.

## 2. Which board

The argument is a board, a work item, or words (rules §0 "Naming a board"):

- **A board** - `AB#1234` (the board whose main is that item), its name or prefix, or its id: `task_context` with it.
  It loads the board, its STAGE and its main item. A board with no brief is filled (section 3); a board with a brief
  is **re-defined** (section 5).
- **A work item with no board yet** (`AB#1234` answers "no board has AB#1234 as its main", `<conn>/1234`, the item's
  URL, or the Start button's waiting `/alfred-setup <conn>/<id>` message): the user asked for this task here, so open
  its board - `board_open` named `AB#1234 <title>`, `askedIn` = the message you are answering (or "terminal"),
  `relateTo` = the board whose chat asked when it was not the project's default board; then `team_link` (board, id)
  makes the item its **main**. Never open one for anything but this request. An item that is already another board's
  main: name that board and use it - never a second one.
- **Words** ("set up a board for the refund export"): with a board open in the chat, fill that board; else
  `board_open` with a short name the user gives (ask if none is obvious), as above.
- `board_record` (kind REC) only when the user said to start recording; else tell them to press Record on the
  board's Cycles tab when ready to test.

## 3. Read everything first

From a work item (the board's main):

1. `team_item` with the id and `seed: true` - the item's own parts (purpose, steps, acceptance, context by the user's
   field maps), then **every page** of the parts `children` and `parents` (`part` + `offset`). Children come in full -
   fields, repro, acceptance, state, comments - with grandchildren as titles; parents up to the top with their
   description and acceptance. The `comments` part holds the item's discussion: decisions made there go under
   Decisions. TOKEN_MISSING: "Enter your token in the Team tab first" and stop - never ask for the token.
2. Attachments: you have no token and never fetch them. Name the ones `team_link` did not attach under the brief's Task
   section - the user fetches them with "Fetch attachments" on the board.
3. The repo: `git branch --show-current` and its base for the Task section.

From words: the user's text, and what they paste or link.

## 4. One draft - then one "Save all"

Draft everything below by the rules in §0a (main item type → shape; each child → its part), then **show it as one
draft** - brief, spec, evidence table, cards table - and ask "Save all?". The user may change or drop any part first;
edit and show again. Save only on yes, in this order: `board_set_brief`, `board_put_spec`, `board_evidence_put`,
`board_add_many`, then `team_link_card` for every card drafted from a child (`askedIn` = the user's "Save all"
message, `hyperlink: false` - no markers, no consent bundle at define), and `board_link_spec` for any card whose
`specItem` was not set.

- **Brief** (`board_set_brief`) in the sections of rules §0:
  ```
  <one line: what the task delivers>

  ## Task
  @[workitem:<conn>/<id>|AB#<id> <title>] - <link>; parents: AB#<feature> <title> → AB#<epic> <title>
  Branch <branch> (base <base>)

  ## Description
  <what the item / the user asked for, in their words - not your summary>

  ## Scope
  - <what this task changes>

  ## Out of scope
  - <what it does not - listen and review never card these>

  ## Test steps
  1. <one action> → AC<n>   (from Test Case children and the item's steps; each names its source item)

  ## Data
  - <accounts, records, values - Investigation findings with their source item>

  ## Decisions
  - <Meeting / Investigation outcomes and comment decisions, with the date and the source item>

  ## Context
  - <other children by the "anything else" rule; children the token cannot read, by id>
  ```
  A step ends with the Acceptance items it exercises (`→ AC5, AC6`): a step is ticked from its items' calls.
- **Spec** (`board_put_spec`, `spec.md` unless the user names one): `# <title>`, `## Acceptance` - one testable
  sentence per item, no "and" - from the item's acceptance (a parent's acceptance is context, not items), `## Out of
  scope`. A Bug main: "the bug no longer happens" plus what its text states.
- **Evidence** (`board_evidence_put`, all items in one call): per item the endpoint whose calls show it and the checks
  each call must pass (rules "Requirement status"), written for the FINISHED feature - never from today's code. Shown as
  a table (item · endpoint · checks).
- **Cards** (`board_add_many`, all land in the Inbox), shown as a table (kind · title · from · Acceptance item):
  - per **Bug** child: a BUG with `### Steps to reproduce`, `### Expected`, `### Actual`, `### Re-test` (the check by
    the calls), its `specItem`, `shortName`, `teams`, and the Bug item named in the description.
  - per **Task** child: a TASK with the task's scope, `specItem` when it serves one item.
  - per **Acceptance item no Task child covers**: a TASK "Not planned in Azure: <item>", no Azure item.
  - per **unclear point**: a QUESTION flagged NEEDS_DECISION (ask it with `board_ask` after saving).
  - a child Azure shows Completed or Removed: still its card, the description opening `> [!INFO] Azure says done`.
  - `firstComment` on each: where it came from and what triage should check.
  Before the table, `board_similar` per card: a card already on the board is linked to the item, not drafted again.
- **Epic main**: one brief section per Feature, its Stories as lines; offer "one board per Feature" as a list the user
  can act on in the Team tab - never open them.

`--dry`: show the draft and stop.

## 5. Re-define - the board already has a brief

Never overwrite. Read what changed first: `team_refresh_item` with the board (Refresh from Azure - new items, changed
items with new comments, the main's move, possible matches), then the seed again as in section 3.

1. **Before → after** per part - Description, Scope, Test steps, Data, Decisions, each Acceptance item, evidence - as
   a table or a ```diff block, with a warning on anything that drops a mark, a card link or a step the calls already
   ticked. Nothing changed → say "No change" and stop (an unchanged board proposes nothing).
2. **Each removal asked one at a time** - an Acceptance item, a test step, a card to close - naming what it loses (its
   marks, its cards, its evidence): asked from the board chat → one `board_ask` per removal on the board; asked in the
   terminal → ask in this conversation, one at a time. Act only on the answered ones.
3. **New cards** only for what is new (a new Bug or Task child, a new uncovered item), after `board_similar`; a match
   to an existing card is linked, not added. Same "Save all" for the additions.
4. **Closes are proposals**: a card whose child item Azure closed or removed, or that the new text no longer needs →
   `board_propose` CLOSED (Not in this flow) with the reason.
5. **The main moved** (closed, removed, out of its iteration): propose closing the open cards as Not in this flow and
   stopping listen, and keep the board for reference - the user decides.
6. **Matches**: for each card with no Azure item, `team_card_matches`; judge each proposal against the card's repro and
   steps and write why (`team_card_matches` with `id` + `why`). Tell the user which to Link on the card (Team panel) -
   you never link or reject one.

## 6. Finish

- Remember the project for this repo if the user wants (offer one line in the repo's `CLAUDE.md`: `Alfred project: <name>`).
- No `## Alfred checks` in the repo's `CLAUDE.md` and the task carries data across steps (search → book, cart →
  order)? Offer once to add the project checks (rules "Project checks") - draft, show, save only on yes.
- `board_session_log` on the board: did (defined / re-defined, N cards, linked), found (capture state, matches), next.
- Tell the user the next stage from `task_context` - normally `/alfred-triage <board>` for the new Inbox cards.
