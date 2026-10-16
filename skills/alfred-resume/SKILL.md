---
name: alfred-resume
description: Pick up an Alfred task (session cycle) exactly where it stands - in a new session, on another machine or after a break - from what Alfred holds, never from an old conversation. Loads the task, says in a few lines where it stands as the Task tab shows it (Needs you, Requirements by group, Test plan and Done when, the brief's open comments, Claude's last run), names the one next step and waits for the user's Go. Use when the user says "resume", "continue the task", "pick up 61813", "where did we leave off", or "/alfred-resume".
argument-hint: "[task name or cycle id]"
---

# Alfred resume

Read `rules.md` in this skill's folder first. This skill **reads and proposes**; it starts no work the user did not
choose (rules §1): every write waits for the user's Go.

Several Alfreds connected (`alfred`, `alfred-docker`, …)? Use the one the user named, else the one whose
`task_context` finds the task; when more than one does, ask.

## 1. Load the task

- No task named: `task_context` with no task lists the tasks, newest first. Show the first few (name, status, last
  activity) and ask which one. Stop there.
- A task named: `task_context` with it. Several match: show them and ask. One matches: that is the whole state - the
  brief by section, the requirements with the user's marks, Claude's suggestions and the calls' verdicts, the test
  steps, the findings and who each waits on, what the user decided, the brief's open comments (BRIEF COMMENTS) and the
  last runs with their Next.

## 2. What changed since the last run

- `board_changes` with cursor `claude`: what the user did since Claude's last entry - answers, moves, closes, marks,
  accepted or dismissed suggestions, brief edits. An answer to one of Claude's questions changes what comes next; say so.
- `board_search` with `mine: true` and `status: [TO_DO, IN_PROGRESS]` for the task's cycle: Claude's cards in flight
  and the "next" of each one's last state comment (`board_get` only for the one that matters now).

## 3. Say where it stands - as the Task tab shows it

The user sees the cycle's **Task** tab (specs/024): a header with the one next step, **Needs you**, then the tabs
Requirements · Test plan · Brief · Claude's runs · Spec & files. Use the same words, so what you say matches the screen:

- **Requirements** by group, in this order: **Decide** (Claude suggested a mark - the user accepts or marks it),
  **Bug**, **Missing**, **Re-test** (Fixed, waiting on a re-test), **Can't tell yet** (calls exist but cannot show it -
  "0 rows" means add test data and search again), **Not checked**, **Met**. Give counts and name the R-numbers of the
  first three groups.
- **Test plan**: steps seen in the calls (N of M), the ones not done, and **Done when** - every requirement marked by
  the user, no open bug or task, every fix re-tested - with what is still ✗.
- **Brief**: open comment threads; a thread where Claude asked and the user answered, or the user asked Claude, needs a
  reply (`board_brief_comment` with `replyTo` - only after the user's Go). A suggested rewording still waiting is the
  user's Apply.
- **Needs you**: suggestions to accept, failed requirements, fixes to re-test, Claude's questions, cards with a
  question or proposal or waiting on the user - oldest first, with how long.
- **Claude's runs**: the newest run's Next.

Answer in this shape, short:

```
Task      61813 Refunded Requests filters · Re-tested phase · 5 of 14 met
Needs you 3 suggestions to accept (R1 R13 R14) · #51 waits on your answer (2 d)
Reqs      Decide 3 · Can't tell 9 (R2 R3 R6 - 0 rows) · Met 2
Test plan 5 / 12 steps seen · Done when ✗ 3 requirements not marked by you
Brief     1 open thread - you asked about "Branch is no longer required"
Since     you marked R4 Pass, reopened #51
Last run  /alfred-listen 10/15: "add refund requests in Cairo and search again"
Next      ▶ Review Claude's suggestions (R1 R13 R14) - then /alfred-listen while you search with data
```

## 4. The one next step

Name the same step the Task tab's **▶ Next** shows, from where the task stands:

| Where it stands | Next |
|---|---|
| no requirements yet | write them - `/alfred-spec` |
| Done when all ✓ | the hand-over - `/alfred-report` |
| a requirement is a Bug or Missing | fix it - `/alfred-fix` with its card |
| a fix waits on a re-test | `/alfred-verify` after the user uses the app again |
| Claude suggested marks | the user accepts or marks them (Requirements → Decide) |
| otherwise | `/alfred-listen` while the user tests the Test plan steps |

Something waiting on the user (a question, a proposal) comes before any of these: name it first. Then ask: **"Go with
<step>?"** - and wait. On Go, run that skill's flow (its own rules apply); on another choice, do that.

## Never

- Never start fixing, re-testing, listening or writing cards before the user's Go.
- Never mark, accept, close, resolve a brief comment or apply a suggested rewording - those are the user's.
- Never rely on an earlier conversation: if Alfred does not hold it, it is not known - say so.
