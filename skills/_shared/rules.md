# Alfred skills - the shared rules

Every `/alfred-*` skill follows these rules. They are copied into each skill's folder on install, so all twelve
behave the same way.

Alfred records the app's traffic: **inbound** calls (the browser into the app), **outbound** calls (the app to its
suppliers), the **SQL** each inbound call ran, the **log lines** it wrote and its **Redis** commands. The **task
board** holds bugs, tasks, notes and questions per project and per session cycle. You reach both through Alfred's MCP
tools (server `alfred`; `board_add` appears as `mcp__alfred__board_add`).

If the Alfred tools are missing, stop and say: "No Alfred is connected - `/alfred-connect <its address>` adds one
(see `/alfred-guide`)." Never guess data.

**Which Alfred.** Several instances can be connected at once (`alfred`, `alfred-lan-80`, …: each its own MCP server,
its tools named `mcp__<name>__…`). Use the one the repo's `CLAUDE.md` names (`Alfred: <name>`); with none named and
more than one connected, ask once which, and offer to write that line. Never mix two instances in one run - a card,
a call id or a cycle belongs to the Alfred it came from.

## 1. The user decides

- You never close a card, set its scope, mark a checklist item, or move a card to Verified or Done.
  **Propose** them: `board_propose` (VERIFIED, DONE, CLOSED with a resolution, MERGE into a duplicate, REOPEN a
  regression) and `board_suggest_mark`. The user accepts or dismisses.
- You move cards only to To do, In progress or Fixed (`board_move`, `board_fix`).
- You edit the text of your own cards only while they are in the Inbox (`board_edit`); after that, comment.
- You never start work the user did not choose. A skill that changes code or writes the brief / spec files asks first
  and waits for the answer.
- A refusal from the board (a dismissed duplicate, a paused board, a limit) is final: report it, do not work around it.

## 2. The card journal - always comment the state

Every card you touch carries a running state in its comments, written with `board_comment` (did / found / next):

- **did** - what you did, or what the user did and answered since your last entry ("You answered Q1: No - filter the
  PCC list by branch; you moved it Inbox → To do").
- **found** - what that means now: the cause, the evidence, the decision.
- **next** - the next step and **who it waits on**: "Waiting on you: answer Q2", "Waiting on Claude: /alfred-fix 11",
  "Waiting on a re-test: open the flight search page again, then /alfred-verify 19".
- Pass `waitingOn` (USER / CLAUDE / RETEST / NONE) whenever it changes.

When:

1. **Opening a card**: right after `board_add`, one comment with what you found, the evidence and the open questions
   (each asked with `board_ask`).
2. **When the user acted** (answered, moved, flagged, closed, edited, commented): on your next visit, one comment on
   that card saying what they did and answered, and what it means now. Answer a comment **in its thread**:
   `board_reply` with `replyTo` = the comment's `[index]` from `board_get`.
3. **At every step of your own work**: starting a fix, a blocker, fixed, verified, still failing.

No noise: at most one state comment per card per visit, and only when something changed. Never ask again a question
the user answered (`board_get` lists `openQuestions`); a question unanswered for more than a day gets one reminder in
the state comment, not a new question.

## 3. One card per problem, with evidence

- Before `board_add`: `board_closed_reasons` (never re-report what the user closed as Fine or Not in this flow),
  `board_similar` (with the call and a title) and `board_for_call`. If a card covers it, add the new calls to it
  (`board_link`) and comment; if two cards are the same problem, `board_propose` MERGE.
- Evidence on every card, in this order, as mentions in the description: the call
  `@[call:in:<id>|METHOD /path · status]` (add `@<cycleId>` for a call in a cycle) → its ERROR / WARN log lines
  `@[log:<callId>/<lineId>|...]` → the code line from the stack trace `@[code:<path>:<line>|File.java:line]` → the SQL
  `@[stmt:<callId>/<seq>|...]` → the spec section `@[spec:<cycleId>/<file>#<section>|...]`. Pass the main call in
  `links`. When the card breaks an Acceptance item, `board_link_spec` it.
- Write every description in this shape - the board shows it as a summary, pills, labelled sections and a highlighted
  Next box, so the reader gets cause, proof and action in that order:

  ````markdown
  **<one sentence: what goes wrong and what the user sees>**

  > <fact> · <fact> · <fact>

  ### Evidence
  - @[call:in:<id>|POST /path · 405] - first failure; retried as #33-#36
  - @[code:<path>:39|File.java:39] - throws, nothing catches it
  ```json
  {"status":405,"error":"METHOD_NOT_ALLOWED"}
  ```

  ### Why it's wrong
  <one or two short sentences>

  ### Backend
  <what Backend changes - only when the card has several teams, one section each>

  ### Frontend
  <what Frontend changes>

  ### Next
  <the one action, e.g. deploy the fix and re-test>
  ````

  Facts are short and countable: `405 × 5 in 6 s`, `no log line ≥ WARN`, `flow stops at search results`. One mention
  per Evidence item with a few words after it - never a paragraph. A response body goes in a ```json block, whole
  (the board pretty-prints it); other bodies in a plain block.

### Teams - every card has its owners

- Read `board_teams` once per run: the teams, what each one **owns**, and their hints. The user edits them in
  Settings → Teams - never assume the six defaults are still there or still named that way.
- Pass `teams` on every `board_add` / `board_add_many`. Decide from the evidence, not the endpoint's name:
  - the page, what it shows or validates, the request the browser sent → **Frontend**
  - a Java exception or stack trace, a 5xx, missing error handling or log lines → **Backend**
  - a failed, rolled-back, slow or repeated SQL statement, data saved wrong → **Database**
  - an outbound supplier call (Galileo, Sabre, NDC...) that errors, times out, is mapped wrong or is swallowed → **Integrations**
  - configuration, deploy, certificates, ports, Redis or other infrastructure → **DevOps**
  - test data, the spec or its acceptance items, a flow not exercised → **QA**
- **One problem, one card - even when it needs several teams.** "The API answers 405 and the page shows a blank list" is
  one card with Backend + Frontend. Its description then has one short `### <Team>` section per team saying exactly
  what that team changes, so each team reads only its part.
- Reassign as you learn (`board_assign`, on any card, with the reason - it goes into the card's history): the 500 turns
  out to be a failed INSERT → Database; the supplier answered fine and our mapping dropped a field → Backend, not
  Integrations. Say the change in the next state comment.
- In state comments, name the team the next step belongs to ("Next (Backend): catch the exception in ...").
- The user can change teams too; a history entry "You set teams: ..." is their decision - do not undo it. Disagree in a
  comment with the evidence, then let them decide.

## 4. What becomes a card

Check every call of the flow (skip OPTIONS preflights, static files, health checks and 304s): status, response body,
its log lines (`call_logs`, `log_context` for the lines just before), its SQL (`db_statements`, `db_statement`), its
outbound calls, its Redis commands, and the spec item the step belongs to (the user's spacers and comments say which
step a call is).

- **BUG** - 5xx (BLOCKER when the flow cannot continue); an **ERROR / FATAL log line** even with a 200 (add the code
  line from `exception_source`); a **WARN that means wrong behaviour** ("ignored", "fallback to default", "retrying",
  "truncated", "could not", "missing") → RISK; failed / rolled-back SQL; the spec says X but the data shows Y (URGENT
  when it is an Acceptance item); request, saved data and response disagree; a supplier error swallowed behind a 200;
  an unexpected 401 / 403 / 404 (not one the user caused on purpose); a secret in a log or response → RISK + URGENT.
  **For every bug check the logs**: attach its ERROR / WARN lines and the lines just before the failure. A failure with
  no log line at all also gets a TASK flagged AFFECTS_PROJECT: "Logging gap: <call> fails with no log line".
- **NOTE flagged RISK** - N+1 queries, the same query or call repeated, a call over **2 s** or 3× slower than the
  endpoint's usual (`endpoint_health`), writes without a transaction; a noisy WARN once, not per call.
- **TASK** - an Acceptance item the cycle never exercised; something the spec asks that the code does not do; a check
  you could not make ("▤ log capture is off for <project>").
- **QUESTION** flagged NEEDS_DECISION - the spec and the behaviour disagree and you cannot tell which is right: ask it
  with `board_ask`.
- **NOTE** - worth knowing, nothing to fix (flag AFFECTS_PROJECT when shared code is involved).

When logs cannot be read (▤ off, or the level above WARN), say so on the card and offer once to turn it on
(`set_log_capture`) - change it only if the user agrees, then report old → new. The same for ◆ database capture.

## 5. Every run

- Keep the live strip current: `board_status` with `step` ("reviewing ODY-482 · 34/120 calls") while you work,
  STOPPED when you stop. If it answers `paused: true`, stop adding cards and tell the user.
- End every run that touched a cycle with **one** `board_session_log` entry (skill, did, found, next).
- `--dry` in the arguments: do everything except writing - list the cards, comments, brief or spec changes you would
  make, and stop.
- Commit only when the user asks. Run the project's tests before saying a fix works.
- No subagents - do the work in this session.
- Finish with a short summary and the next command to run (`/alfred-...`).

## The flow

(`/alfred-connect` once per instance) → `/alfred-setup` → (`/alfred-spec`) → `/alfred-listen` while testing, or `/alfred-review` after → `/alfred-triage` →
`/alfred-sync` ↔ `/alfred-fix` → use the app again (re-test) → `/alfred-verify` → `/alfred-report`. `/alfred-status` and
`/alfred-guide` anytime.
