---
name: alfred-triage
description: Sort an Alfred board's Inbox together with the user - one card at a time, swept for duplicates and root-cause groups, worst first, each investigated (earlier cards, the call, code, database, schema, spec, git) before a short summary and a recommendation (Fine, Not in this flow, To do, merge, ask) with the reason and a confidence; the user decides, Claude records each decision on the card. Use when the user says "triage", "sort the inbox", "go through the findings", or "/alfred-triage".
argument-hint: "[AB#1234 | board name or id | project] [--dry]"
---

# Alfred triage

Read `rules.md` in this skill's folder first and follow it. Closing and scope are the user's: you recommend, the user
decides, and you never close a card yourself.

**Asking** (specs/037): every `board_ask` follows rules "Asking well" - the evidence goes in `details`; questions for someone outside Alfred go out as `board_questions_form`, and an answers file that comes back goes through `board_import_answers` (dry run first, apply on the user's yes).

## 1. The Inbox

A board given (`AB#1234`, its name or id - rules §0): `task_context` with it, then `board_search` with that `board`
and `status: [INBOX]`; a project: `board_search` with the project and `status: [INBOX]`. `board_closed_reasons` to
know what the user dismissed before. Nothing in the Inbox → say so and give the next step from `task_context`'s NEXT.

### 1a. Sweep the whole Inbox first

Before any single card, one pass over all of them:

- **Earlier cards, once per Inbox**: `board_get` + `board_evidence` for every card, then `board_for_call` on every
  card's main calls and `board_similar` per card - one sweep, reused by every card below (step 2a.1 reads it, it does
  not repeat it).
- **Root-cause groups**: cards that share an exception class + line, a statement fingerprint (the same SQL from
  `db_statement`), a code line, or the same endpoint failing the same way. Each group becomes one recommendation:
  **merge #14 #17 #22 #23 into #12** - the card with the best evidence (or the oldest open card outside the Inbox)
  as the target, with what they share in one line.
- **Severity, worst first**: score each card (or group) and go through them in that order, not oldest first:
  - calls affected (`endpoint_health`, `search_logs` for the error text) - one call or every call;
  - spread - how many users, branches, agencies or tenants the calls carry (headers, body fields);
  - impact - a 5xx or a wrong answer over a slow one; the slowest time for performance cards;
  - blocks an Acceptance item (`board_requirements`) - always first.

  Show the order once: `Inbox 9 cards → 4 groups. Worst first: #12 (+3 merged) · #11 · #19 · #30`.

## 2. One card at a time

For each card (or group): **investigate before you judge** (2a) - never recommend from the card's text alone. Show:

```
#11 BUG  read-pnr 409 for a PCC the import page offered          severity 2 of 4 · 38 calls, 6 branches
What: …one line…   Evidence: POST /read-pnr · 409, ImportBookedPnrService.java:121
Checked: #6 same 409 (closed Fine 10/02: "PCC 7XB is test-only") · line 121 unchanged · 2 statements, 0 rows for PCC
Teams: Frontend + Backend - the page offers the PCC, the service refuses it
Recommend: To do - the page offers PCCs the branch cannot use (Acceptance 2).   Confidence: High
```

**Confidence** on every recommendation:

- **High** - the evidence decides it on its own: an exact duplicate, the user's own earlier reason for the same
  thing, a code line that plainly does it, the spec saying so.
- **Medium** - the evidence points one way, but one check could not be done (no statements, no logs, no schema).
- **Low** - it rests on a guess; say which fact is missing. A Low card is **ask first** or reproduced (2b), never
  merged or closed on it.

The user may answer several at once ("11 todo, 12 fine") or **"accept all High"** - then record every High
recommendation as if answered one by one (step 3), list them, and keep going with the rest. "Accept all High" never
covers a Medium or Low card.

### 2c. Put the advice on the card - always

The board shows Claude's advice only from a Triage question on the card, so ask it there in both modes (chat and
board): one `board_ask` per card or group, in severity order, with the triage fields filled - not only in the text:

- `questions`: one question, header `Triage`, "What should happen to #n?", `why` = the one-line evidence (the calls as
  mentions, what they sent and answered).
- `options`, labelled exactly so (the card's buttons and Triage mode answer the same question by label): `To do`,
  `Fine`, `Not in this flow`, `Merge into #n` (a duplicate of #n), and on a group's target card `Merge #14 #17 into #12`.
  The one you advise `recommended: true` with a **`description`** - why, in one line the user reads on the tile
  ("Branch approval is not part of task 61813 - no SQL to act on"), never just the option again - and **`confidence`** `high` / `medium` / `low` (2 above) - the tile, the
  questions dialog and Triage mode show it as a label, and the board's **Accept all High** applies only `high`. Each
  option with `then` (what you will do) and a `preview`: what changes, the calls, which Acceptance items it covers or
  leaves uncovered, why, and the earlier cards it found as mentions.
- **`checked`**: the `Checked:` line (2a) - what you checked and what you could not.
- **`severity`**: `{rank, of, note}` - its place worst first (1 = worst), how many were ranked, and why ("blocks AC6 ·
  181 statements"). The Inbox and Triage mode sort by it.
- **`group`** (on the group's target card only): the numbers of the cards to merge into it. Their own Triage
  questions advise `Merge into #12`.
- Skip a card that already has an open Triage question (`board_get` lists it) - never ask twice; re-ask only by
  withdrawing the old one first (`board_withdraw_question`, the reason: what changed).

In chat, the user may answer here instead: record the decision (step 3), then `board_withdraw_question` the card's
Triage question with "decided in chat: <choice>" so no question stays open on a sorted card.

### 2d. Planned cards - a look at the code (specs/030)

Cards `/alfred-setup` drafted from the work item (a TASK per Task child or uncovered Acceptance item, a BUG per Bug
child) have no calls yet: judge them from the code, not the traffic. For each, before the Triage question:

- **Where the change goes** - the file or class (`codegraph explore "<words of the card>"` when `.codegraph/` exists,
  else `locate_source` / search the repo): `@[code:<path>:<line>|File.java:line]`.
- **Which team owns it** - from where the change goes (rules "Teams"); `board_assign` when it differs.
- **Is it already written** - the task branch's change (`git diff --stat <base>...HEAD`, then the files that matter) and
  `git log --since=<the card's creation>` on those files: name the file:line and the commit (`a1b2c3d "add branch
  filter"`). Written → recommend **Record as fixed** (High only when the code plainly does what the card asks).
- A card marked "Azure says done" with nothing on the branch → **ask first**: done elsewhere, or still to do?

The Triage question's options for a planned card: `To do`, `To do (another team)` with the team in its `then`,
`Not in this flow`, and `Record as fixed` when the code is written - its `then`: "`/alfred-fix <n>` records the fix
(commit, branch) and moves it to Fixed; `/alfred-verify` can prepare the Azure update". The `Checked:` line names the
file:line and the commit, or "nothing on <branch> yet".

### 2a. Investigate before you judge

The card was written by an earlier run; its evidence may be thin or stale. Check, in this order, and stop as soon as
the recommendation is certain:

1. **Earlier cards** - always, from the sweep (1a): open, fixed and closed cards about the same problem, with their
   resolution and the reason the user gave.
   - The same problem still open → **merge into #n**.
   - Fixed and the calls are after the fix → **ask first**: a regression of #n (`board_regressions` for the endpoint).
   - Fixed and the calls are before the fix → **Fine** - "fixed in #n, re-test with `/alfred-verify`".
   - Closed as Fine / Not in this flow for the same reason → recommend the same, quoting the user's reason.
2. **The call** - `investigate_call` on the main call when the card has no ERROR / WARN line or no statement; the
   lines just before the failure with `log_context`. Is it this call's failure, or one a call before it caused
   (`call_story`)?
3. **The code** - when the card names a class, a line or an exception: `exception_source` / `locate_source`, or the
   repo's CodeGraph (`codegraph explore "<class method>"` when `.codegraph/` exists), else read the handler. Confirm
   the line still does what the card says (it may be fixed since) and say which team owns it.
4. **The database** - when the card is about data (0 rows, a wrong value, a slow query): `db_overview` and
   `db_statement` for the statement it names (its SQL, its binds, its rows, its time); `db_query` searches that call's
   recorded statements and rows (never the application's database). "0 rows" with no matching data is **Can't tell -
   add test data**, not a bug.
5. **The schema** - when a statement, a column or a mapping is in question: the table's definition from the repo
   (migrations - Flyway/Liquibase, `schema.sql`, DDL files - and the entity mapping: JPA/Hibernate annotations,
   `*.hbm.xml`, MyBatis mappers). Does the column exist, is it nullable, is there an index on what the slow query
   filters by, does the entity map the column the SQL uses?
6. **How often** - `endpoint_health` for the endpoint, or `search_logs` / `log_problems` for the error text (every
   project's caught lines and the Logs Explorer's files): one call, or every call? A one-off on a dead connection is not
   the same card as a failure on every call.
7. **What was asked** - `read_spec`, `get_brief` and `board_requirements` for the card's cycle: is it in this flow
   (else **Not in this flow**), which Acceptance item it breaks, and did the brief or a decision already call this
   behaviour expected (then **Fine**, quoting it).
8. **What changed** - whenever the card names a file, a class or a line: `git log --since=<the card's first call>`
   on that file, and `git log -L` on the method. Say it as `touched by a1b2c3d 2 d ago ("fix PCC filter") - likely
   fixed`: a commit since the calls may have fixed it (**re-test** with `/alfred-verify`, not To do) or caused it
   (name the commit and its author line). No commit since → "line unchanged since the calls".
9. **Anything else this session can reach** - other connected tools and files, read-only: a database tool for the
   application's database (does the row exist, what the data really is - SELECT only, never a write), an issue
   tracker for a known ticket, the project's docs and `CLAUDE.md` for the intended behaviour, the application's log
   files in the repo or on disk. Name each source in the `Checked:` line. Never write to any of them during triage.

Write what you checked in the `Checked:` line - what you found, and what you could not check and why ("no
statements - ◆ off"). Something you could not check never becomes a pass. If a check changes the card's facts (wrong
line, another team, it happens on every call), say so and offer the correction (`board_comment` with Found, or
`board_assign`).

Check the card's teams against the evidence (rules "Teams"); propose a change in the same line ("Teams: Backend →
Database - the INSERT fails") and apply it with `board_assign` when the user agrees or does not object.

Recommendations: **To do** (real, in scope), **Fine** (expected behaviour - say why), **Not in this flow**, **merge
into #n** (same problem), **ask first** (a decision is needed - name the question). Then wait for the user's choice
(they may answer for several cards at once: "11 todo, 12 fine, 14 merge 11", or "accept all High").

### 2b. Reproduce on demand

For an **ask first** or **Low** card whose failure depends on what a supplier or the app answered (an error, a
timeout, an odd value), offer to reproduce it once: `rule_recipes`, then `rule_from_call` on the card's call and
`rule_preview` to show exactly which requests it would match - narrow (one endpoint, one distinguishing field), saved
**off**, never pausing. Say: "Rule `<name>` is saved off - switch it on, run the step once, switch it off; I will
read the call." The user switches it on; after their call, `rule_hits` and `investigate_call` on the new call, then
re-judge the card with the new evidence (confidence up or down). Never switch a rule on yourself; offer the rule's
removal once the card is judged.

### Started from the board (▶, a `board_run_take` run)

The user is on the board, not in this chat - advice shown only here is lost, and waiting here for an answer never
ends. So sweep (1a), investigate (2a) and ask every card on the board (2c) - no chat block.

Then `board_run_end` with `→ asked on #47-#50 - answer on the cards` and stop: do not wait. The user answers in the
questions dialog, sorts the card with its buttons or in Triage mode (F / N / T / M - that answers the question too), or
takes every High advice with **Accept all High**; a merge the user makes (the ⇢ Merge button, M) is done at once. The
answers reach Claude through `/alfred-live` or `/alfred-sync`, which records them as in step 3.

## 3. Record the decision

- To do → `board_move` TO_DO (yours to do), state comment: what the user decided and why, `waitingOn` CLAUDE, next
  `/alfred-fix <n>`.
- Record as fixed → `board_move` TO_DO, state comment naming the file:line and commit, next "`/alfred-fix <n>` records
  it" - the fix is recorded by `/alfred-fix` (`board_fix`), never by triage.
- Fine / Not in this flow / Won't fix → the user closes it (the card's buttons) - offer `board_propose` CLOSED with
  that resolution and the reason so it is one click; note it in the state comment. **Learn from it**: for every
  Fine / Not in this flow, write the rule that would have kept this card out - an `allowed` check line (rules
  "Learning": the endpoint, the field or signal, the value or range, the user's reason) - and propose it at the end,
  so the same thing never becomes a card again.
- A `Learn:` card → not sorted like a finding: show its open questions; the user answers on the card (Answer
  button) or tells you here - then record them in one state comment ("You answered 1: ...") and note the check lines
  they give.
- Merge → the user merged it already on the board (⇢ Merge, Triage mode's M, Accept all High): nothing to do but the
  state comment on the target card. Decided in chat → `board_propose` MERGE into the card (one per card of a group).
- Ask → `board_ask` the question, `waitingOn` USER.
- Teams the user changed or confirmed → `board_assign` (reason: "decided in triage") if not already set.

`--dry`: sweep (1a), investigate (2a) and show the recommendations for every card, worst first, then stop.

## 4. Finish

New check lines (allowed lines, `Learn:` answers): one before / after of the repo's `## Alfred checks`, saved only on
yes.

Summary: moved to To do, merges proposed (by group), proposed closes waiting for Accept, questions asked, rules saved
off for reproducing (and whether to remove them), check lines proposed - and how many were accepted as High. `board_session_log` on the cycle when the
cards belong to one. Next: answer questions on the board, then `/alfred-sync`; or `/alfred-fix`.

## Team tracker: Incoming first (specs/028)

Before the Inbox, for each board in scope: `team_incoming` - work items that arrived (new in the main's tree, watch
rule, hook, by hand). For each waiting one: `board_similar` on its title, then `team_propose_card` - LINK to the card it
matches (cardId, with the evidence) or NEW, with a one-line reason. Features and Epics stay related items: propose no
card for them. The user accepts in the lane; you never make the card or the link yourself.
Then, while sorting the Inbox: a card with no Azure item - `team_card_matches` first (Alfred's proposals from the
board's tree): judge each and write why (`id` + `why`); the user links it on the card. With none, a card that matches
an open bug in the tracker (`team_search` with its words, types [Bug], openOnly) gets a link proposal -
`team_link_card` without `askedIn` - and says so in its comment.
