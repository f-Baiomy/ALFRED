---
name: alfred-listen
description: Listen to an Alfred session cycle live while the user tests - check every new call (HTTP, ERROR/WARN logs, SQL, supplier calls, Redis) against the cycle's spec, open cards with evidence and a first state comment, tick the test steps, and answer the user's comments on the board as they come. Use when the user says "listen to cycle X", "watch while I test", or "/alfred-listen".
argument-hint: "<cycle> [--dry]"
---

# Alfred listen

Read `rules.md` in this skill's folder first and follow it - especially "What becomes a card" and the card journal.

## Start

1. The cycle (`list_cycles` by name). `get_cycle`: its project and whether it is recording - if not, tell the user to
   press Record (listening still works; it waits for calls).
2. `get_brief` (purpose, test steps, spec files, existing cards), `read_spec` for each spec file (the Acceptance list
   and its `[key]`s), `board_closed_reasons` for the project.
3. Say in two lines what you will check (the Acceptance items, the test steps) and that you are listening.
   `board_status` WATCHING with `step` "listening to <cycle>".
4. Calls already in the cycle: check them first (`search_cycle` / `problem_calls` scoped to the cycle, then
   `investigate_call` on each suspect).

## Loop - until the user says stop

- `wait_for_calls` on the cycle (new calls) and `board_wait` with `by: USER` (the user's comments, answers, moves).
- **Each new call**: apply "What becomes a card". For a finding:
  1. `board_similar` + `board_for_call` - join an existing card (`board_link` + a state comment) instead of a new one.
  2. `board_add` (or `board_add_many`) with `cycleId`, the evidence in the description, the main call in `links`, and
     its `teams` (rules "Teams" - `board_teams` once at the start).
  3. Right after: the first state comment (`board_comment`, `waitingOn` USER: it waits to be sorted) and any question
     with `board_ask`; `board_link_spec` the Acceptance item it breaks.
  4. A short `add_comment` on the call in the cycle when it helps the user see the problem in place.
- **Test steps**: match calls to the brief's steps (by the user's spacers, comments and the endpoints) and
  `board_mark_step` SEEN (with the call count) or FAILED (with the card number).
- **The user's change** (`board_wait`): a comment → answer it in its thread (`board_reply` with `replyTo`); an answer to
  your question → act on it and write the state comment; a move / close → note it on your next state comment.
- `board_status` with the counts and `step` ("listening to <cycle> · 34 calls · 3 cards").

## Stop

`board_status` STOPPED. `board_session_log` on the cycle: did (calls checked), found (cards added / updated, steps
seen / failed / untested, Acceptance items with no evidence), next. Summary to the user, then: "Sort the Inbox:
`/alfred-triage`".
