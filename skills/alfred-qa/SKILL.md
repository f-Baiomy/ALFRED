---
name: alfred-qa
description: QA a feature with Alfred - listen to a session cycle while the user tests, check every call (HTTP, database, logs, Redis) against the cycle's spec, report bugs/risks/tasks/questions on the Alfred task board, fix the cards the user accepted, verify fixes against a re-test cycle, and resume from anywhere. Use when the user says "listen to cycle X", "QA this flow", "work the board", "fix the To do cards", "verify the re-test", or "continue the board".
argument-hint: "listen <cycle> | fix [card#] | verify <re-test cycle> | resume"
---

# Alfred QA

You work the Alfred task board through Alfred's MCP tools (server `alfred`; tools such as `board_add` appear as
`mcp__alfred__board_add`). Alfred records the app's traffic: inbound calls (the browser into the app), outbound calls
(the app to its suppliers), the SQL each inbound call ran, the log lines it wrote and its Redis commands. The board
holds bugs, tasks, notes and questions per project and per session cycle.

If the Alfred tools are missing, stop and say: "Alfred's MCP server is not connected - run `claude mcp list`; see
Alfred's docs/mcp.md." Do not guess data.

## Pick the mode from the input

| Input | Mode |
|---|---|
| `listen <cycle name or id>` | [Listen](#listen) |
| `fix` or `fix <card#>` | [Fix](#fix) |
| `verify <re-test cycle>` | [Verify](#verify) |
| `resume`, nothing, or "continue" | [Resume](#resume) |

A cycle may be given by name: find its id with `list_cycles`. A project is the cycle's project (from `get_cycle`), or
ask once if there are several.

## Rules - always

1. **The user decides.** Never close a card, set its scope, mark a checklist item, or move a card to Verified or Done.
   Propose those with `board_propose` / `board_suggest_mark`. You may move cards only to To do, In progress or Fixed.
2. **Never re-report what the user dismissed.** Read `board_closed_reasons` at the start. A refusal from `board_add`
   that names a closed card is final - drop that finding.
3. **One card per problem.** Before `board_add`, run `board_similar` (with the call and a title) and `board_for_call`.
   If a card already covers it, add the new calls to it (`board_link`) or comment on it - do not add another.
4. **Evidence on every card**, in this order, as mentions in the description:
   call `@[call:in:<id>|METHOD /path · status]` (add `@<cycleId>` for a call in a cycle) → error/warning log lines
   `@[log:<callId>/<lineId>|...]` → the code line from the stack trace `@[code:<path>:<line>|File.java:line]` → SQL
   `@[stmt:<callId>/<seq>|...]` → the spec section `@[spec:<cycleId>/<file>#<section>|...]`. Then one plain line:
   why it is wrong. Pass the main call in `links`.
5. **Say what you changed in Alfred.** If you turn log or database capture on, or change the log level
   (`set_log_capture`, `set_db_capture`), ask first and then report old → new.
6. **Commit only when the user asks.** Run the project's tests before saying a fix works.
7. **No subagents** - do the work in this session.
8. Keep the live strip current: `board_status` WATCHING with counts while listening, STOPPED when you stop. If it
   answers `paused: true`, stop adding cards and tell the user.

## What becomes a card

Check **every** call of the flow (skip OPTIONS preflights, static files, health checks and 304s). For each call look
at: status, response body, the call's log lines (`call_logs`, `log_context` for what came just before), its SQL
(`db_statements`, `db_statement`), its outbound calls, its Redis commands, and the spec item the step belongs to
(the user's spacers and comments in the cycle say which step a call is).

### BUG - the app does something wrong
- 5xx response. Flag BLOCKER when the flow cannot continue.
- **ERROR or FATAL log line** during the call - even when the status is 200. Add the code line from
  `exception_source`.
- **WARN log line that means wrong behaviour** ("ignored", "fallback to default", "retrying", "truncated",
  "could not", "missing") → BUG flagged RISK.
- SQL failed or rolled back (constraint, deadlock).
- Spec says X, data shows Y - e.g. "discount is stored" but the INSERT wrote `DISCOUNT = NULL`. Flag URGENT when the
  item is in the spec's Acceptance list.
- Request sent X, database saved Y, response returned Z (they disagree).
- A supplier error hidden behind a 200 (an `<Error>` / `"error"` in an outbound response the app swallowed).
- An unexpected 4xx: 401/403 on a page the user may open, 404 on a link the app itself produced. Not a 4xx the user
  caused on purpose (wrong password, a validation message the UI shows correctly) unless the spec says otherwise.
- A secret (password, token, card number) in a log line or a response → BUG flagged RISK and URGENT.

**For every BUG, also check the logs**: attach the call's ERROR and WARN lines and the lines just before the failure
(`log_context`) - the first error is usually the cause. If the call failed and **nothing** was logged, add a TASK
flagged AFFECTS_PROJECT: "Logging gap: <call> fails with no log line".

### NOTE flagged RISK - works, but dangerous
- N+1 queries (many near-identical SELECTs in one call), the same query or call repeated in one request.
- A slow call: over **2 s**, or 3× slower than the same endpoint in earlier cycles (`endpoint_health`).
- Writes without a transaction, or a partial write after an error.
- A WARN that is noise ("deprecated") - only once, not per call; nothing at all if it repeats on every call.

### TASK - missing, not broken
- An Acceptance item the cycle never exercised: "Acceptance 3 (refund) - no call seen".
- Something the spec asks for that the code does not do yet.
- A check you could not make: "Item 2 not verified - ▤ log capture / ◆ database capture is off for <project>".

### QUESTION flagged NEEDS_DECISION - spec and behaviour disagree and you cannot tell which is right
- Ask with `board_ask` on the card: "Spec says discount before tax; code applies it after. Which is intended?"

### NOTE - worth knowing, nothing to fix
- A pattern ("login makes 3 redirect hops"); context for a later fix, flagged AFFECTS_PROJECT when shared code is
  involved ("OrderMapper is also used by the admin export").

When logs cannot be read (▤ off, or the level is above WARN), say so on the card. Offer once to turn ▤ on or lower the
level to WARN; change it only if the user agrees (rule 5).

## Listen

1. `get_cycle` (name, project, recording state), `get_brief` (what the cycle is for, its spec files, its cards),
   `read_spec` for each spec file (the Acceptance list is the checklist), `board_closed_reasons` for the project.
2. Tell the user in two lines what you will check (the Acceptance items) and that you are listening.
   `board_status` WATCHING.
3. Check the calls already in the cycle (`search_cycle` / `problem_calls` scoped to it, then `investigate_call` on
   each suspect).
4. Loop until the user says stop:
   - `wait_for_calls` on the cycle for new calls, and `board_wait` (cursor from the previous answer, `by: USER`) for
     the user's comments and moves - answer a comment with `board_reply`, act on an answer to your question.
   - For each new call apply [What becomes a card](#what-becomes-a-card). Add findings with `board_add` (or
     `board_add_many` for several), `kind` and `flags` as above, `cycleId` set. Add a short `add_comment` on the
     call in the cycle when it helps the user see the problem in place.
   - Update `board_status` with calls checked and cards added.
5. On stop: `board_status` STOPPED, then a summary: cards added by kind, the Acceptance items with no evidence yet,
   and what the user should sort in the Inbox.

## Fix

Only cards the user moved to **To do** (or the one card number given).

1. `board_search` with `status: [TO_DO]` (the project, or `mine: false` everywhere if no project is known). Take them
   one at a time, URGENT and BLOCKER first.
2. `board_get` the card (every comment), `board_evidence` (its call, SQL, logs in one call), `board_move` IN_PROGRESS.
3. Find the code: `exception_source` / `locate_source` from the stack trace or endpoint, then read the code.
4. If the card is flagged AFFECTS_PROJECT, or the fix changes code other flows use: stop, `board_comment` the plan
   with did/found/next and impact, and ask the user before changing anything.
5. Make the smallest fix, add or update a test, run the tests.
6. `board_fix`: summary, root cause, files with lines, commit (only if the user asked you to commit), tests run and
   their result, how to verify, impact. It moves the card to Fixed.
7. Next card. At the end: list what is Fixed and say "record a re-test cycle, then `/alfred-qa verify <cycle>`".

## Verify

1. `board_verify` with the project and the re-test cycle (`apply: false` first) and show the verdicts:
   LOOKS_FIXED, STILL_FAILING, NOT_EXERCISED.
2. Re-check each LOOKS_FIXED card with its own rules (the log lines and SQL of the new calls, not just the status).
   Then `board_verify` with `apply: true` - it proposes Verified on the fixed ones and comments "still failing" on the
   others - or do it card by card with `board_propose` / `board_comment`.
3. For the cycle's spec: for each Acceptance item with clear evidence in the re-test cycle, `board_suggest_mark`
   PASS or FAIL with the call and SQL mentions as evidence; CANT_TELL when the cycle did not cover it.
4. Tell the user what is waiting for their Accept (proposals and suggested marks) and what is still failing.

## Resume

1. `board_search` with `mine: true` and `status: [TO_DO, IN_PROGRESS, FIXED]`, and `board_changes` with cursor
   `claude` (everything the user did since your last entry).
2. Summarise: what you were doing (the cards In progress and their last Next), what the user changed or answered,
   proposals still waiting, new To do cards.
3. Ask which mode to continue - or continue the In progress card if the user already said so.
