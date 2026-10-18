---
name: alfred-guide
description: Teaches the Alfred skills and the right QA flow - the seven stages of a task (Board, Define, Triage, Code, Verify, Test, Close) and all seventeen /alfred-* skills - answers "how do I use Alfred with Claude", "what should I do next", "listen vs review", "setup vs spec", "Start vs New board", "why doesn't Claude see my logs", and walks a first run step by step. Use whenever the user asks how the /alfred-* skills work, what to do next on the board, or how to start - in any words or language.
argument-hint: "[anything you want to know - 'what next', 'walk me through it', 'what does review do'...]"
---

# Alfred guide

Read `rules.md` in this skill's folder first: it is what every Alfred skill follows, so your explanations match.
This skill only **reads** - never create cards, cycles, comments, briefs or anything else here.

A board is a task with its own brief, spec, chat and cards; its cycles are its recordings (rules §0). Only the user
opens a board. Every skill takes the board as `AB#1234` (the board whose main is that work item), its name or its id;
a bare `#12` is always a card.

Answer in the user's language, at the depth they asked: one line for a quick question, a walkthrough when they want
to learn. Always end with the exact next command.

## The seven stages (show this first when asked how it works)

Every task goes the same way (rules §0a). The board's header shows the stage strip with the current stage and its
command; `task_context` prints the same STAGE and NEXT - Alfred computes both, so they always agree.

| Stage | What happens | Command |
|---|---|---|
| 1. Board | you make it in the Team tab or the Board page: **New board** from a work item or your words (nothing runs by itself), or **▶ Start** on a work item = New board + ask Claude in the board chat | - |
| 2. Define | Claude reads the item, its parents up to the Epic and every child in full, and drafts the brief, spec, test steps, data, decisions, evidence AND the cards (a BUG per Bug child with a reproduce scenario, a TASK per Task child and per Acceptance item no task covers); you say "Save all" | `/alfred-setup AB#1234` |
| 3. Triage | the Inbox, one card at a time, with a look at the code: where the change goes, which team, already written? You decide each | `/alfred-triage AB#1234` |
| 4. Code | you write it on the task branch | - |
| 5. Verify | every Acceptance item per layer, every card against the code - "Record as fixed?" (with an optional Azure update) when a To do is already written | `/alfred-verify AB#1234` |
| 6. Test | press Record on the board's Cycles tab and use the app; listen ticks steps, re-tests Fixed cards and opens cards for what fails | `/alfred-listen AB#1234` |
| 7. Close | the report, and one bundle for the main item that you approve | `/alfred-report AB#1234` |

"↻ Refresh from Azure" on the board brings new comments, states, bugs and tasks back as proposals; run
`/alfred-setup AB#1234` again to re-define (before → after, each removal asked).

## The skills - all seventeen

| Stage | Skill | When |
|---|---|---|
| - | `/alfred-guide` | Learn, "what next?", troubleshooting |
| - | `/alfred-connect <address>` | Once per Alfred instance (this machine, another port, a LAN host, a tunnel): checks it and adds it to Claude Code |
| - | `/alfred-update-skills` | After updating Alfred: brings these skills up to the installed version |
| 2 | `/alfred-setup <board / AB#id / words>` | Define the task - brief, spec, evidence, steps, data, decisions and the cards in one draft, one "Save all". Again on a defined board: before → after, removals one at a time, card matches judged |
| 2 | `/alfred-spec <board> …` | One targeted change to the brief or a spec file (shows a diff, asks) - setup is for the whole shape |
| 3 | `/alfred-triage <board>` | Sort the Inbox together: a recommendation per card with a code look, you decide |
| 3 | `/alfred-sync` | After you answered questions or changed cards: one state comment per card |
| 4 | `/alfred-fix [card#]` | Fixes only the cards you choose, after you say Go; records code already written |
| 5 | `/alfred-verify <board> [cards] [--wait] [--tests]` | **Before testing**: is every Acceptance item built (backend, frontend, database)? **After fixes**: re-tests from the live calls since each fix, checks every card against the code ("Record as fixed?"), proposes Verified |
| 6 | `/alfred-listen <board>` | **While** you test: checks each batch of calls, opens cards, ticks steps, re-tests Fixed cards; its own background process, no model while calls are clean, until `/alfred-listen stop` |
| 6 | `/alfred-review <board / cycle>` | **After** a cycle is recorded: checks every call, fills the board, finds regressions against earlier runs |
| 6 | `/alfred-live [board]` | Claude answers you on the board within seconds - comments, replies, questions, any change - beside listen, until `/alfred-live stop` |
| 7 | `/alfred-report <board>` | A summary for a stand-up or PR; at Close, one bundle for the main item |
| - | `/alfred-status [board]` | What waits on you, on Claude, on a re-test - the stage and the next step |
| - | `/alfred-resume <board>` | Pick a task up in a new session or on another machine, exactly where it stands |
| - | `/alfred-team …` | The tracker: search, link, start a board, "update card #n", matches, Create in Azure - every write waits for your approval |
| - | `/alfred-ask <id>` | Run by the board for a question asked from a snippet or the ✦ menu - not typed by you |

**Setup vs spec**: setup defines or re-defines the whole task from the item or your words; spec changes one part.
**Start vs New board**: New board only makes the board (nothing posted); Start also posts `/alfred-setup` to the board
chat for a live runner to answer. **Listen vs review**: listen while you test, review after.

## "What should I do next?"

Look at the real board, read-only: `task_context` on the task in play (no task: it lists them) - its STAGE and NEXT
are the answer; `board_next_steps` for the project (and `board_search` with `mine: true`, `board_changes` cursor
`claude` when useful) for the rest. Then answer with the one most useful next step and its command, e.g.:

- a board with no brief → `/alfred-setup AB#1234` (stage Define)
- questions wait on the user → "Answer the 2 questions on #11 (the Answer button on the card), then `/alfred-sync`."
- cards in the Inbox → `/alfred-triage AB#1234`
- To do cards, none Fixed → write the code, then `/alfred-verify AB#1234`; a "Record as fixed?" answered → `/alfred-fix <n>`
- Fixed cards → "Press Record on the board's Cycles tab, use the app as each card's re-test steps say, with
  `/alfred-listen AB#1234` running - or `/alfred-verify` after."
- everything Verified or closed → `/alfred-report AB#1234` (Close)

## Walkthrough ("teach me", "walk me through it")

Small steps; after each, wait for the user to do it and check it happened before explaining the next:

1. Alfred is running and connected (`list_projects` answers). If not: `/alfred-connect <its address>`. The token for
   the tracker is entered once in the Team tab.
2. Team tab → find the work item → **New board** (or the Board page → New board with your words). The board opens
   with "Not defined yet".
3. `/alfred-setup AB#1234` - read the one draft (brief, spec, evidence, cards), change what you want, say "Save all".
4. `/alfred-triage AB#1234` - decide each card in the Inbox.
5. Write the code on the task branch, then `/alfred-verify AB#1234` - every item per layer; answer "Record as fixed?".
6. Board page → Cycles tab → Record, run `/alfred-listen AB#1234`, click through the test steps. New calls show on the
   Calls tab.
7. Answer questions on the cards, `/alfred-sync`; `/alfred-fix` what fails; use the app again; `/alfred-verify`.
8. `/alfred-report AB#1234` - and approve the bundle for the main item when you are happy with it.

## Explaining one skill

Say: when to use it, what it asks the user, what it writes on the board (cards, state comments, session log), where it
stops for the user, and one example command. Take it from the tables above and `rules.md`.

## Troubleshooting

- **No Alfred tools** - no instance is connected, or it is down: `/alfred-connect <its address>` (or
  `/alfred-connect list` to see what is connected and why one fails). Start a new Claude Code session after.
- **Several Alfreds** - the skills use the one the repo's `CLAUDE.md` names (`Alfred: <name>`), or ask.
- **"No board has AB#1234 as its main"** - make the board first (Team tab → New board), then run the command again.
- **"Enter your token in the Team tab first"** - Claude never holds the token; enter it there (kept 8 hours in memory).
- **No log lines / no SQL on calls** - ▤ log catching or ◆ database capture is off for the project, or the agent is not
  attached (Settings → Database capture; `alfred attach` on a native install).
- **listen sees nothing** - the board's cycle is not recording (Cycles tab → Record), the wrong project, or inbound
  logging is off for it.
- **Claude stopped adding cards** - the board is paused (the live strip's Resume).
- **"Refused: same as #n"** - you closed that problem as Fine / Not in this flow; reopen the card if it is real.
- **"Everything was 200 - why a card?"** - listen and review compare what one step hands to the next (rules "Flow
  consistency"): a value that changes or disappears between steps is a bug even when every status is fine. What
  Claude cannot tell it asks once on a `Learn: <flow>` card; your answers are kept in the repo's `CLAUDE.md` under
  `## Alfred checks` after your yes.
- **"Held by …" / HELD** - another user holds the board (specs/031): read it, and ask for it from the 🔒 button on the
  board; their answer hands it over, releases it or keeps it.
- **One session per board** - the board's ▶ alfred-live starts its own Claude session on your PC - the first time it
  offers **⬇ Connect this PC**: run the downloaded file once and everything (helper, skills, MCP server) is set up and
  kept current - shows it in Claude Desktop (▶ menu ▸ Restart Claude Desktop; trust the folder once) and keeps answering
  the board from it.
- **New session, another machine, another agent** - nothing is lost: Alfred keeps the task's whole state.
  `/alfred-resume AB#1234`; without the skills, the MCP prompt `resume` (`/mcp__<server>__resume <task>`).

## What Claude never does

Open a board on its own, close a card, set scope, mark the checklist, move to Verified / Done, start a fix you did not
choose, or send anything to the tracker without your approval - it proposes and asks. Every card it touches says who
it waits on.
