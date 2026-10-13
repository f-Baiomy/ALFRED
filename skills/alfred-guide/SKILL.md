---
name: alfred-guide
description: Teaches the Alfred skills and the right QA flow, answers "how do I use Alfred with Claude", "what should I do next", "listen vs review", "why doesn't Claude see my logs", and walks a first run step by step. Use whenever the user asks how the /alfred-* skills work, what to do next on the board, or how to start - in any words or language.
argument-hint: "[anything you want to know - 'what next', 'walk me through it', 'what does review do'...]"
---

# Alfred guide

Read `rules.md` in this skill's folder first: it is what every Alfred skill follows, so your explanations match.
This skill only **reads** - never create cards, cycles, comments, briefs or anything else here.

Answer in the user's language, at the depth they asked: one line for a quick question, a walkthrough when they want
to learn. Always end with the exact next command.

## The skills (show this when asked for an overview)

| Step | Skill | When |
|---|---|---|
| 0 | `/alfred-guide` | Learn, "what next?", troubleshooting |
| - | `/alfred-connect <address>` | Once per Alfred instance (this machine, another port, a LAN host, a tunnel): checks it and adds it to Claude Code |
| 1 | `/alfred-setup [project] ["description"]` | Start a task: checks Alfred, creates the cycle, writes the brief (test steps) and a spec with an Acceptance list from your description - asks before saving |
| 2 | `/alfred-spec <cycle> …` | Add or change the brief or spec files (shows a diff, asks) |
| 3 | `/alfred-listen <cycle>` | **While** you test: checks each step's calls in one batch when you pause - every call, nothing skipped - opens cards, ticks the test steps, suggests Acceptance marks at the end |
| 4 | `/alfred-review <cycle>` | **After** a cycle is recorded (yours or anyone's): checks every call, fills the board, finds regressions against earlier runs - also a field that went missing behind a 200 |
| 5 | `/alfred-triage` | Sort the Inbox together: a recommendation per card, you decide |
| 6 | `/alfred-sync` | After you answered questions or changed cards: one state comment per card |
| - | `/alfred-live [project] [cycle] [--model m]` | Claude answers you on the board within seconds - comments, replies, answers, questions, any change - showing each step on the card while it works; its own background process beside listen, a line per event here, until `/alfred-live stop` |
| 7 | `/alfred-fix [card#]` | Fixes only the cards you choose, after you say Go |
| 8 | `/alfred-verify [cards] [cycle]` | Re-tests the fixes from the live calls since each fix (or a cycle), proposes Verified, suggests checklist marks |
| 9 | `/alfred-status` | What waits on you, on Claude, on a re-test - and the next step |
| 10 | `/alfred-report` | A summary for a stand-up or PR |
| - | `/alfred-update-skills` | After updating Alfred: brings these skills up to the installed version (for you and the repo's own copy) |

The flow: **setup → (spec) → listen or review → triage → sync ↔ fix → re-test → verify → report**; status and guide
anytime.

## "What should I do next?"

Look at the real board, read-only: `task_context` on the task in play (no task: it lists them) - it names the next
step itself; `board_next_steps` for the project (and `board_search` with `mine: true`, `board_changes` cursor `claude`
when useful) for the rest. Then answer with the one most useful next step and its command, e.g.:

- questions wait on the user → "Answer the 2 questions on #11 (the Answer button on the card), then `/alfred-sync`."
- cards in the Inbox → `/alfred-triage`
- To do cards → `/alfred-fix` (it asks which)
- Fixed cards → "Use the app as each card's re-test steps say (or ▶ Re-test on the board), then `/alfred-verify`."
- a cycle with no brief or spec → `/alfred-spec <cycle>` or `/alfred-setup`
- nothing open → `/alfred-report`, or start a new task with `/alfred-setup`

## Walkthrough ("teach me", "walk me through it")

Small steps; after each, wait for the user to do it and check it happened before explaining the next:

1. Alfred is running and connected (`list_projects` answers). If not: `/alfred-connect <its address>`.
2. `/alfred-setup <project> "<what the task is>"` - read the brief and spec drafts, say OK.
3. Start recording the cycle (Session Cycles → the cycle → Record), run `/alfred-listen <cycle>`, click through the flow.
   Check new calls appear (`get_cycle`).
4. Stop; open the Board: the Inbox has the findings. Run `/alfred-triage`.
5. Answer any question on a card (Answer button), then `/alfred-sync`.
6. `/alfred-fix` - pick the cards, say Go.
7. Use the app again as the cards' re-test steps say (no recording needed; ▶ Re-test on the board records one if you want), `/alfred-verify`, accept the proposals.
8. `/alfred-report`.

## Explaining one skill

Say: when to use it, what it asks the user, what it writes on the board (cards, state comments, session log), where it
stops for the user, and one example command. Take it from the table above and `rules.md`.

## Troubleshooting

- **No Alfred tools** - no instance is connected, or it is down: `/alfred-connect <its address>` (or
  `/alfred-connect list` to see what is connected and why one fails). Start a new Claude Code session after.
- **Several Alfreds** - the skills use the one the repo's `CLAUDE.md` names (`Alfred: <name>`), or ask.
- **No log lines / no SQL on calls** - ▤ log catching or ◆ database capture is off for the project, or the agent is not
  attached (Settings → Database capture; `alfred attach` on a native install).
- **listen sees nothing** - the cycle is not recording, the wrong project, or inbound logging is off for it.
- **Claude stopped adding cards** - the board is paused (the live strip's Resume).
- **"Refused: same as #n"** - you closed that problem as Fine / Not in this flow; reopen the card if it is real.
- **"Everything was 200 - why a card?"** - listen and review compare what one step hands to the next (rules "Flow
  consistency"): a time, fare or passenger that changes or disappears between search, confirm and book is a bug even
  when every status is fine. Claude learns what must match from the calls and the code; what it cannot tell it asks
  once on a `Learn: <flow>` card. Your answers, your Fine closes and the runs you confirm as good are kept in the repo's
  `CLAUDE.md` under `## Alfred checks` (rules "Project checks") - after your yes - so nothing is asked twice.
- **New session, another machine, another agent** - nothing is lost: a cycle is a task and Alfred keeps its brief,
  requirements, findings, decisions and Claude's earlier runs. Any skill starts from `task_context`; without the skills
  (another agent, a fresh install) use the MCP prompt `resume` - in Claude Code `/mcp__alfred__resume <task>`.
- **A `Learn:` card in the Inbox** - Claude's questions about a flow. Answer them on the card (or in `/alfred-triage`),
  then `/alfred-sync`.

## What Claude never does

Close, set scope, mark the checklist, move to Verified / Done, or start a fix you did not choose - it proposes and
asks. Every card it touches says who it waits on.
