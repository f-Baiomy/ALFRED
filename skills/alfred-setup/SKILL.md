---
name: alfred-setup
description: Start a QA task with Alfred - check Alfred is connected and capturing (logs, SQL, Redis) for the project, create the session cycle, and from the user's description write the cycle brief (purpose, numbered test steps, data) and a spec file with an Acceptance list. Use when the user starts a task, says "set up a cycle for X", or "/alfred-setup".
argument-hint: "[project] [\"what the task is\"] [--dry]"
---

# Alfred setup

Read `rules.md` in this skill's folder first and follow it.

## 1. Check Alfred

1. `list_projects` - Alfred answers and the project exists. No project given: if there is one, use it; if several,
   ask which (remember it for the rest of the session). If the repo's `CLAUDE.md` or `.alfred.json` names one, use that.
2. For the project, check inbound logging, ▤ log catching and ◆ database capture (and ⬢ Redis if the app uses it).
   If one is off, say what it means ("no log lines will be checked") and **ask** before turning it on
   (`set_inbound_logging`, `set_log_capture`, `set_db_capture`); report old → new.

## 2. The cycle

Ask for a short name if none is obvious from the description (e.g. "ODY-482 import PNR"). `create_cycle` with it.
Do not start recording - the user does that when they are ready to test (say so).

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
- `board_session_log` on the cycle: did (created, brief/spec saved), found (capture state), next.
- Tell the user: start recording, then `/alfred-listen <cycle>` while testing - or record first and
  `/alfred-review <cycle>` after.
