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

- **Brief** (`board_set_brief`):
  ```
  <one paragraph: what the task is and why>

  ## Test steps
  1. <a step the tester does, one action each>
  2. ...

  ## Data
  - <accounts, records, settings the steps need>
  ```
  The numbered list under "Test steps" is what listen / review tick off - keep one action per step.
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
