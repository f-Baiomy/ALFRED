---
name: alfred-verify
description: Verify fixes with Alfred - every Fixed card judged twice, implemented (the code, the branch, the running build, every layer) and worked (the calls), ready for Verified only when both hold; re-test every Fixed card (or the ones named) against the live calls since its fix, or a re-test cycle, by the card's expectations (SQL count, status, log lines, duration, response) with before → after; check each Acceptance item's code layer by layer (backend, frontend, database) in every source this session can reach, on the task branch, and say which layer it cannot reach; check every open card against the code (a fix still there, a To do already written - asks "Record as fixed?"); find Acceptance items added to the spec since the last verify and draft their evidence; catch a fix the running build does not carry yet; runs before testing (is everything built?) and after fixes, and beside a running /alfred-listen; propose Verified or comment "still failing" with the evidence, check guards and regressions of Done cards, and suggest checklist marks. Use when the user says "verify", "check the fixes", "re-test", or "/alfred-verify".
argument-hint: "[AB#1234 | board name or id] [card numbers] [re-test cycle] [project] [--wait] [--tests] [--dry]"
---

# Alfred verify

Read `rules.md` in this skill's folder first and follow it.

Verify on the board the card lives on (its home); the re-test is a cycle of that board - `board_record` with kind RETEST (rules §0 "Boards and cycles"). (specs/027) Verified and Done are the user's: you propose.

## 1. What to re-test

- **The board**: `AB#1234`, its name or id (rules §0 "Naming a board") → `task_context` with it: its STAGE says which
  run this is (Code/Verify = before testing, Test = a re-test), its NEXT what follows. A bare `#19` is card 19.
- **Cards**: numbers in the arguments (`/alfred-verify 19`, `/alfred-verify 18 19`) → only those (step 2 and 2d); none → every Fixed card, and every open card in 2d.
- **Calls**: by default the **live calls since each fix** - no cycle needed; the user just used the app. A cycle name in
  the arguments (`list_cycles` by name) → only that cycle's calls. An argument in angle brackets (`<re-test cycle>`) is a
  placeholder: ignore it.
- `--wait`: re-test what is left together with the user (3b). `--tests`: also run each fix's tests (2. step 4).
- Catch up first: `board_changes` cursor `claude` (state comments for what the user did - and keep its spec entries
  for 2e). `board_status` step "verifying #18 #19" - unless `/alfred-listen` runs (1b).

**Which run this is** - pick it yourself, say it in the first line:
- **Before testing** - the task has no Fixed card and no call since the app's last start (`board_requirements`: every
  item NOT_EXERCISED or NO_EVIDENCE). Typically right after `/alfred-setup` and writing the code. Order: 2e → 2c → 2d →
  report → close with the test steps and `/alfred-listen <cycle>`. Nothing is re-tested: there is nothing to re-test.
- **Re-test** - anything else. Order: 2 (step 0 first) → 2b → 2c → 2d → 2e → 3 → 4.
Cards vs code (2d) and new spec items (2e) run in both, whatever the cards say. 2c and 2e need a task (2b says when
there is one); with none, say so and run 2d on the project's open cards.

## 1b. While `/alfred-listen` runs

Verify may run beside listen - in the chat that runs it (a ▶ `/alfred-verify` from the board lands there) or another.
Listen runs when `task_context` shows `NOW: Claude watching …` for the cycle, or (runner on this machine)
`node "<the alfred-listen skill's folder>/alfred-listen.mjs" status --server <server> --cycle <cycle id>` says running.
Then:
- **The live strip is listen's** - one status per project: never call `board_status` in this run (no "verifying", no
  STOPPED - a STOPPED would show listen as stopped). Progress shows in this chat only.
- **No second comment on the same calls** - before each state comment, `board_get` the card: when listen already wrote
  about the same calls since the fix, `board_reply` under its comment with what verify adds (before → after, the code)
  instead of a new comment.
- **A refused proposal** (one already open - listen's finish proposes REOPEN too) is "already proposed by listen", not
  an error.
- In the chat that runs listen, its watch lines keep coming: write nothing in reply to them (listen's rule).

## 2. Fixed cards - implemented, and worked

A Fixed card is judged twice (specs/026), and both are recorded on the card - the board shows them as two chips:

- **Implemented** - from the code and git, which only you can read: the fix's commit on the task branch, in the running
  build, every layer the card's teams own changed (a Backend + Frontend card needs both), nothing reverted it since,
  and with `--tests` its tests pass. Verdict: `implemented`, `not_on_branch`, `not_in_build`, `layer_missing`,
  `reverted`, `tests_fail`, or `unknown` (the code is not reachable in this session - say which repo).
- **Worked** - from the calls since the fix, by the card's expectations (step 1).

Only **implemented ✓ and worked ✓** is ready for Verified. Pass every card's implemented verdict to `board_verify` as
`implemented: [{number, verdict, commit, branch, layers: [{team, where, ok}], tests, note}]` - it records each on the
card before the calls are judged, and each check comes back with `implemented` and `ready` lines.

0. **Is the fix implemented?** For each card, before judging it: the commit its fix recorded (`board_get`,
   the `board_fix` entry; none → find it with `git log` on the fix's files, else `unknown`) and the repo that holds the
   fix's files (see 2c "Sources").
   - `git merge-base --is-ancestor <commit> <task branch>` fails → the fix is **not on the task branch** (another branch,
     not merged, rebased away). Say which branches hold it (`git branch -a --contains <commit>`).
   - `board_retest` gives `appStarted` (the app's last start Alfred saw). The commit is newer
     (`git show -s --format=%cI <commit>`) → the **running build does not carry the fix**: the app was not restarted
     or redeployed since. No `appStarted` → say "Alfred never saw the app start - can't tell which build runs".
   A card in either case is never moved back to In progress for what its calls show: those calls ran the old code.
   State comment "the running build does not carry the fix (commit <sha> at <time>, app started <time>) - restart /
   redeploy, then re-test" (or "the fix is not on <branch> - merge it"), `waitingOn` RETEST.
   - Each layer of the card's teams (`board_teams`, the card's `teams`): the change in that layer's repo on the task
     branch (`git diff <base>...<branch> -- <files>`, CodeGraph, the fix's `files`) → `{team, where: "File.java:88", ok}`;
     a layer with no change → `ok: false` and the verdict `layer_missing`.
   - `git log <commit>..<branch> -- <the fix's files>`: a later commit that undid it → `reverted`, name the commit.
1. `board_verify` with the project, `numbers`, `cycleId` if one was named, `record: true` (keeps each card's
   re-test in its history and returns the report) and `implemented` (step 0, one per card). Then per card, by **both**:
   - **Not implemented** (`layer_missing`, `reverted`, `tests_fail`) - whatever the calls say: state comment naming what
     is missing (the layer, the reverting commit, the failing test), `board_move` IN_PROGRESS, `waitingOn` CLAUDE, next
     `/alfred-fix <n>`. A card that worked on the API but misses its Frontend change is not fixed.
   - **`not_in_build` / `not_on_branch`** - step 0's comment; never judged by its calls (they ran the old code).
   - **PASSES and implemented** - every call since the fix meets every expectation. Look at the before → after values;
     when the card has no expectations (`statusOnly`) check its own evidence too: the new calls' ERROR / WARN lines
     (`call_logs`), the SQL the card was about (`db_statements`). Then `board_propose` VERIFIED with the calls and the
     commit as evidence ("Implemented and worked: …"), state comment, `waitingOn` USER.
   - **PASSES, code `unknown`** - propose Verified saying plainly "worked - code not checked (<repo> not in this
     session)"; the user decides.
   - **FAILS / FLAKY** - state comment with the failing values and calls, `board_move` IN_PROGRESS, `waitingOn` CLAUDE,
     next `/alfred-fix <n>` - unless step 0 found the build does not carry the fix (then step 0's comment, no move).
   - **PARTIAL** - a step not done yet, or a duration waiting for more calls: state comment naming what is left,
     `waitingOn` RETEST.
   - **NO_CALLS** - nothing called the endpoint since the fix: state comment "not re-tested yet - <the card's steps>",
     `waitingOn` RETEST. `newBuild` means the app restarted after the fix: say "the new build is running - re-test now".
   - **NOT_CHECKABLE** - the card names no call: say so; ask the user which call shows it.
2. A card whose re-test needs a failure (its card links an `@[rule:...]`): `list_rules` - when it is off, ask the user
   to switch it on and run the step; after, `rule_hits` and judge the calls it touched like any other.
3. A card without expectations: write them now with `board_retest_plan` from its "Verify:" text (ask in chat first,
   show them), so the next re-test checks more than the status.
4. `--tests` only: run the tests of each card's fix - the test files next to the fix's `files` and the ones the task
   branch's diff touches, by the repo's own targeted command (its `CLAUDE.md` / `AGENTS.md`: one module, one spec -
   never the whole suite). Long runs in the background. The result goes in the card's state comment (passed / failed,
   the first failing assertion verbatim). A failing test is a finding, never something verify fixes; it does not
   decide the verdict - the calls do - but a PASSES card with a failing test is proposed with that said plainly.

## 2b. The task

When a cycle is named, or the repo's current branch is the one a cycle's brief names (`task_context` lists the
tasks): `board_requirements` on it - each Acceptance item's verdict by the calls since the last build (`board_verify`
with `cycleId` gives the one-line `task` too); then 2c for each item. Report it after the Fixed cards:
`Task 61813: NOT DONE - 5 missing (#41), 2 no data, 1 not exercised, 2 manual`. A task is not done while an item is
MISSING or WRONG, whatever the cards say. **No Fixed card of the task** → say it plainly first: "Nothing of task
61813 was fixed or re-tested; by the calls the task is …, by the code …" (a before-testing run: "not tried yet; by
the code …"). Never let an unrelated card's result stand for the task. MET items whose card is still open → `board_propose` as the card's status allows.

## 2c. The code, layer by layer

Only verify does this - listen judges behaviour and stays fast. **The calls still decide** (rules.md "Checking the task
against what was asked"): code found never makes an item MET and never lifts a FAILS. The code answers what the calls
cannot: is an item that nobody exercised built at all, and in which layer is a missing one missing.

**Sources.** The layers are the teams that own code (`board_teams`: Backend, Frontend, Database - whatever they are
named now). For each, find where its code is in this session: the working folder and every folder added to the session,
by what is in them (`pom.xml` / `build.gradle` → backend; `angular.json` / `package.json` with a UI framework →
frontend; `db/migration`, Liquibase changelogs, `*.sql` migrations, `@Entity` / `@Table` classes → database). The repo's
`CLAUDE.md` may already map them under `Alfred sources:` - use that and do not detect. Nothing mapped and the guess is
not certain → ask once in chat, then offer to save the answer there (show the block, write it only on a yes):

```
Alfred sources:
- Backend: . (this repo)
- Frontend: ../odeysys-ui
- Database: ./src/main/resources/db/migration
```

**Branch.** The task's branch is the one its brief names (`task_context`). In each source repo:
`git rev-parse --abbrev-ref HEAD`; another branch checked out → say so ("frontend is on master, not
feature/multi-branch") and read the task branch without switching: `git diff --stat <base>...<task branch>`,
`git show <task branch>:<file>`. The branch does not exist in that repo → `git fetch` once, still missing → that layer
has no change for the task. Never check out, stash or pull.

**Per Acceptance item, per layer** - one verdict each, with the file and line that shows it:
- `FOUND` - the change on the task branch does what the item needs in that layer: a handler or field that carries it
  (backend), the control or the request field that sends it (frontend), the table / column / index a migration adds
  (database).
- `NOT_FOUND` - the layer is reachable and nothing on the task branch does it.
- `UNREACHABLE` - the layer's code is not in this session. Say it exactly: "Frontend: can't tell - its code is not in
  this session (add its folder, or map it under Alfred sources)". Never guess what is in code you cannot read.
- `OTHER_BRANCH` - found, but only on a branch that is not the task's.
Search with CodeGraph first where the repo has `.codegraph/` (`codegraph explore "<item's words> <endpoint>"`), then the
task branch's diff; once per item, reusing what an earlier item found. For the database also look at the calls: a
statement on the item's table recorded in a call since the last build (`db_statements` on that call) proves the table
exists in the running database whatever the migrations say.

**Read the two together:**

| Calls | Code | Say |
|---|---|---|
| NOT_EXERCISED / NO_CALLS | NOT_FOUND in a layer | not built yet - name the layer(s) |
| NOT_EXERCISED / NO_CALLS | FOUND in every layer | built, not tried - name the step that tries it |
| MISSING / WRONG | backend FOUND, frontend NOT_FOUND | the API carries it, the UI does not send it → Frontend |
| MISSING / WRONG | frontend FOUND, backend NOT_FOUND | the UI sends it, the API drops it → Backend |
| MISSING / WRONG | FOUND in every layer | the running build is older than the code (2. step 0) or the code is wrong - say which |
| any | a layer UNREACHABLE | what the reachable layers show, and that the rest can't be told |
| MET | anything | MET - a layer NOT_FOUND is only a NOTE (the item may be met another way) |

**Cards - one per problem, a section per team.** An item with an open card (a linked TASK / BUG): `board_comment` on it
with what the code shows, one `### <Team>` section per layer that has to change ("### Frontend - the branch filter
sends `branchId`; it must send `branchIds`, `search-panel.component.ts:142`"), and `board_assign` when the layers say
the owners are not the card's teams (with the reason). An item with no card and code NOT_FOUND: no card from code alone
- the calls open cards. List it in the report as "not built yet (by the code)" and ask in chat whether to open a card for
it (`board_add`, into the Inbox, linked to the item).

## 2d. Cards vs code

Every open card of the task (or of the project when no task) whose change is code - Fixed, To do, In progress; not
the Inbox, not `Learn:` cards. Same sources and branch as 2c; CodeGraph first, then the task branch's diff.

- **Fixed** - beyond step 0 (the commit is on the branch): is the change **still there**? Take the lines the fix added
  (`git show <commit> -- <the fix's files>`) and look for them in the task branch's version (`git show <task
  branch>:<file>`). Gone or rewritten → "the change is gone from `<file>` (overwritten by `<sha>`: `git log <task
  branch> -L` / `git log -S`)": judge the card as FAILS whatever its calls show (state comment with the file and the
  commit that removed it, `board_move` IN_PROGRESS, next `/alfred-fix <n>`). Still there → one line in the report.
  No commit recorded → look for the fix's files and what its summary says in them; can't tell → say so.
- **To do / In progress** - is the change the card asks for **already written** on the task branch? Look for what the
  card's description (its `### <Team>` sections), its linked Acceptance item and its evidence name: the field, the
  handler, the control, the table. Found → ask on the card, never move it yourself (recording a fix is
  `/alfred-fix`'s):
  - `board_ask` with one question - "The code for this looks written: `<file:line>` (commit `<sha>`, `<date>`). Record
    it as fixed?" - and three options (specs/030): **Record as fixed** (`recommended`, `then`: "`/alfred-fix <n>` shows
    this code, waits for your Go, records it with board_fix and a re-test plan, and moves the card to Fixed"),
    **Record + prepare Azure update** - only when the card is linked to a work item (`team_card_items`) - (`then`:
    "as Record as fixed, and `/alfred-fix <n>` prepares one bundle for the item: a comment naming the commit and
    branch, and the state Resolved (Bug) or Closed (Task) - it waits for your approval on the card"), **Not done yet**
    (`then`: "I leave the card as it is and look again on the next verify"). A `preview` with the lines found and,
    for the second, the comment and the state the bundle will hold.
  - A state comment with the same finding and `next` "`/alfred-fix <n>` - records the code already written", so the
    card's next step is a ▶ on the board; `waitingOn` USER.
  - The same question already open on the card → do not ask twice; mention it in the report.
  Not found → one line in the report ("#22 To do - nothing on the branch yet"), nothing written.
- A card answered **Not done yet** since the last verify: do not ask again until its code changes (a newer commit
  touching the files you found).

## 2e. New in the spec

Requirements added to the task's spec after the code was written must not hide behind the old ones. Spec files have no
versions (an item is keyed by its text), so an item is **new** when any of these says so:
- `board_changes` since Claude's last entry (step 1's catch-up) has a `spec replaced` entry or an added / changed
  Acceptance item for the cycle;
- `board_requirements` shows it NO_EVIDENCE (listen drafts evidence for every item when it starts - one added later
  has none);
- its key is not in the `Items checked:` line of the last verify entry in the cycle's session log (`task_context`
  "earlier runs").
For each new item:
1. 2c for it - FOUND / NOT_FOUND / UNREACHABLE per layer.
2. No evidence → draft it now (`board_evidence_put`, as rules "Requirement status" says: endpoint + checks), so Alfred
   judges its calls from the next one. Refused because the user wrote it → keep theirs.
3. Report it in its own section first - "New in the spec since the last verify" - with what each layer misses.
An item whose text changed is new too: its old verdict, marks and code findings were about the old text.

## 3. Guards, regressions and the spec

- `board_regressions` for the project: regressions and **guards failed** (a Verified / Done card's expectations broken
  by a later call) → `board_propose` REOPEN with the calls.
- With a re-test cycle: `board_mark_step` its steps; `board_suggest_mark` each Acceptance item with clear evidence
  (PASS / FAIL with mentions; CANT_TELL when not covered).

`--dry`: `board_verify` without `record`; 2c, 2d and 2e read only (no comment, question, evidence or move); show the
verdicts and what you would propose / comment / ask, and stop.

## 3b. `--wait` - re-test what is left, together

Without `--wait`, the report ends with the list below and the user runs `/alfred-verify <numbers>` again later.
With it, after the report:
1. List exactly what is left to try, one line each: the card or item, the step from its re-test plan or the brief, and
   the endpoint whose call shows it ("#19 - open Agencies, pick two branches, Search → `POST /agency/search`"). Cards
   waiting on a restart (2. step 0) come first: "restart the app first".
2. A recording cycle to listen on (the named one, or the task's when it is recording): `wait_for_calls` on it with
   `settleSec` 5 and `sinceCallId` from the previous reply, `timeoutSec` 60, until calls arrive. Not recording → ask the
   user to press Record or to say "done" in chat when they have tried the steps, then go on with the live calls.
3. `board_verify` again with only the cards and items still left (`numbers`, `record: true`), 2c only for items whose
   verdict changed. Report only what changed (before → after), act on it as in 2, and list what is still left.
4. Stop after 3 rounds, when nothing is left, or when the user says stop. A round with no calls to any listed endpoint
   says so and does not count.

## 4. Finish

`board_status` STOPPED (not while listen runs, 1b). `board_session_log` on the task's cycle (or the re-test cycle) -
always when there is a task, since the next verify reads it: `found` ends with one line
`Items checked: AC1 AC2 … AC11` (every Acceptance item's key this run saw), so 2e can tell what is new next time.
Summary: the report (passed, failed, flaky, partly checked, not covered) with before → after, proposals waiting for
Accept, reopened, then the build line, what is new in the spec, the cards against the code, and the code item by item:

```
Re-test run · task 61813
Build: app started 10:42 · #18 carries its fix · #19 fix a1b2c3d (11:05) not in the running build - restart
New in the spec since the last verify (2):
  AC10 export to Excel     Backend NOT_FOUND · Frontend NOT_FOUND · Database n/a  → not built yet
  AC11 audit row on save   Backend FOUND AuditService.java:40 · Database NOT_FOUND → migration missing
Cards vs code:
  #18 Fixed   fix a1b2c3d on the branch ✓ · change still in SearchController.java:88 ✓
  #19 Fixed   change gone from AgencyMapper.java (overwritten by 7f3e2c1, merge of develop) ✗ → In progress
  #22 To do   code already on the branch (ExportService.java:12) → asked "Record as fixed?" · /alfred-fix 22
  #24 To do   nothing on the branch yet
Task 61813 · branch feature/multi-branch (backend ✓ on it, frontend ✗ on master, database ✓)
AC3 multi-branch search   calls: NOT_EXERCISED
   Backend   FOUND      SearchController.java:88 (branchIds list)
   Frontend  NOT_FOUND  (read from feature/multi-branch, master is checked out)
   Database  FOUND      V42__branch_filter.sql
   → backend and database ready, the UI does not send it yet (Frontend)
AC5 export by agency      calls: MISSING
   Backend   UNREACHABLE  (no backend code in this session)
   → the calls show it missing; can't tell whether code exists
```

Next - a before-testing run: build what is NOT_FOUND, answer the "Record as fixed?" questions, then try the steps
with `/alfred-listen <cycle>`. A re-test run: accept the proposals on the board; restart the app for fixes it does not
carry; answer "Record as fixed?" (`/alfred-fix <n>` records it); `/alfred-fix` for what still fails;
`/alfred-verify --wait` to re-test what is left together; `/alfred-report` when done.

## Team tracker (specs/028, 030)

**The Azure update** ("Record + prepare Azure update", run by `/alfred-fix` once the fix is recorded): one bundle on
the card - `team_comment` with the commit, branch and a one-line summary (no secrets), then `team_move_state` with
`extend` = that bundle and the state **Resolved** for a Bug, **Closed** for a Task. The tool proposes the closest
allowed state when the item's type lacks that one and says so (`stateNote`): write that in the comment. Never approve
it; tell the user it waits on the card.

When the user moves a card to Verified or Done, Alfred prepares a "Tell Azure" bundle for each linked item (state,
comment, an evidence file built masked) - it waits for the user's approval on the card; mention it in the summary, never
approve it. A linked item closed in the tracker before the card was verified: say so ("closed elsewhere by <who>") and
propose, do not move the card.
