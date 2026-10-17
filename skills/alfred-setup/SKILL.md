---
name: alfred-setup
description: Start a QA task with Alfred - check Alfred is connected and capturing (logs, SQL, Redis) for the project, open the task's board with its first recording, and from the user's description or a work item (AB#1234, <conn>/1234) write the board brief (purpose, numbered test steps, data) and a spec file with an Acceptance list. Use when the user starts a task, says "set up a board for X", presses Start on a work item, or "/alfred-setup".
argument-hint: "[project] [\"what the task is\" | AB#1234 | <conn>/1234] [--dry]"
---

# Alfred setup

Read `rules.md` in this skill's folder first and follow it.

## 1. Check Alfred

1. `list_projects` - Alfred answers and the project exists. No project given: if there is one, use it; if several,
   ask which (remember it for the rest of the session). If the repo's `CLAUDE.md` or `.alfred.json` names one, use that.
2. For the project, check inbound logging, ▤ log catching and ◆ database capture (and ⬢ Redis if the app uses it).
   If one is off, say what it means ("no log lines will be checked") and **ask** before turning it on
   (`set_inbound_logging`, `set_log_capture`, `set_db_capture`); report old → new.

## 2. The board

A task is a board: its brief, spec, requirements, chat and cards; its session cycles are its recordings.

- Ask for a short name if none is obvious from the description (e.g. "ODY-482 import PNR").
- `board_open` with it, `askedIn` = the chat message you are answering (or "terminal"), and `relateTo` = the board
  whose chat asked, when it was not the project's default board. Claude never opens a board on its own - only for
  this user request.
- A work item that already has a board (`team_item` says `board`): do not open a second one - say which board it has.
- `board_record` (kind REC) makes the board's first recording only when the user said to start recording; else tell
  them they start it when ready to test.

### From a work item (AB#1234, <conn>/1234, or the Start button's `/alfred-setup <conn>/<id>`)

1. `team_item` with the id - the item from Alfred's shared cache, as a seed: purpose, steps, acceptance, context (by
   the field maps the user set), the parent's acceptance, a Feature's children, attachments by name and link. Read a
   long part with `part` + `offset`; never shorten it. Not in the cache: say "AB#<id> is not in the cache yet: Refresh
   the Team tab first" and stop.
2. Name the board after the item (`AB#1234 <title>`), open it as above, in the project the start was posted to.
3. Draft the brief and spec from the seed (section 3): Description = purpose and context as given; Test steps from
   steps (or the children, one step each); Acceptance from acceptance, then the parent's acceptance when the item has
   none of its own. Keep the item's link under Task.
4. Attachments: you have no token and never fetch them. Name the ones `team_link` says it did not attach, under the
   brief's Task section, by name and link - the user fetches them with "Fetch attachments" on the board.
5. Last, `team_link` (board, id): Alfred keeps a snapshot of the item so the board shows when it changes in the tracker,
   and moves the attachments the user's Start fetched onto the board.

## 3. Brief and spec from the description (only when one was given)

Draft both, **show them, and ask "Save these?"** - edit them as the user says, save only on yes:

- **Brief** (`board_set_brief`) - the task, in the sections of rules §0, so any later session, machine or agent
  reads it from `task_context`:
  ```
  <one line: what the task delivers>

  ## Task
  <ticket id / link, the branch (git branch --show-current) and its base>

  ## Description
  <what the ticket or the user asked for, in their words - not your summary>

  ## Scope
  - <what this task changes>

  ## Out of scope
  - <what it does not - listen and review never card these>

  ## Test steps
  1. <a step the tester does, one action each> → AC<n>
  2. ...

  ## Data
  - <accounts, records, values the steps use - the ones that must survive to the end>

  ## Decisions
  - <empty at first; the user's decisions are added here as they are made>
  ```
  The numbered list under "Test steps" is what listen / review tick off - keep one action per step, and end it with the
  Acceptance items it exercises (`→ AC5, AC6`): a step is ticked from its items' calls, never from spacers. A ticket
  pasted or linked: its text goes under Description as given, and its acceptance criteria into the spec below.
- **Spec** (`board_put_spec`, name `spec.md` unless the user gives one) - only when the description holds
  requirements:
  ```
  # <task title>

  ## Acceptance
  1. <one testable sentence: given / when / then in plain words>
  2. ...

  ## Out of scope
  - <what this task does not cover>
  ```
  Each Acceptance line is one checklist item: testable, one behaviour, no "and".
- **Evidence** (`board_evidence_put`, all items in one call, right after the spec is saved - it needs no approval of
  its own): for each Acceptance item, the endpoint whose calls show it and the checks each such call must pass (rules
  "Requirement status"). Alfred then judges every call in code as it arrives and opens a "Missing feature" card the
  moment a call shows an item is not built - with no model and nobody in the way. Write it for the FINISHED feature,
  from the description and the spec - never from the code as it is today. Show the evidence as a short table with the
  drafts (item · endpoint · checks); the user may change it later on the Task tab, and their version wins.

`--dry`: show the drafts and stop.

## 4. Finish

- Remember the project for this repo if the user wants (offer to add one line to the repo's `CLAUDE.md`:
  `Alfred project: <name>`).
- No `## Alfred checks` in the repo's `CLAUDE.md` and the task carries data across steps (search → book, cart →
  order)? Offer once to add the project checks (rules "Project checks") for that flow - draft the lines, show them,
  save only on yes.
- `board_session_log` on the board: did (opened, brief/spec saved, linked), found (capture state), next.
- Tell the user: start recording, then `/alfred-listen <cycle>` while testing - or record first and
  `/alfred-review <cycle>` after.
