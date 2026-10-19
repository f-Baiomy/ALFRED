# Alfred skills - the shared rules

Every `/alfred-*` skill follows these rules. They are copied into each skill's folder on install, so all of them
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

## 0. The task harness - Alfred is the memory, not the conversation

A **board** is a **task**: a piece of work whose code is finished and must now be checked against what was asked.
Everything about it lives in Alfred - so a new session, another machine or another agent continues exactly where the
work stands, and nothing depends on a conversation that is gone.

- **Boards and cycles** (specs/027): a board holds the brief, spec files, requirements, chat and cards; its session
  cycles only hold calls - its recordings and re-tests. One cycle may be on several boards (one recording for two
  tasks); each project has a default board for cards that belong to no task. The task tools take `board` (a board id
  from `board_boards`) or a `cycleId`; a cycle on several boards answers with the boards to pick - ask the user which,
  never guess. A finding goes to the board whose requirement the call shows (`board_home`), and a card lives on one
  home board, shown as related on the others.
- **A cycle's description is the user's** (specs/033): what it is for, its steps (`- [ ] Search POST /api/search` -
  a step with an endpoint ticks itself), what is expected; `get_cycle` shows it first - read it before judging the
  cycle. Never change it. Your own note goes in `cycle_summary` (2-4 sentences, when asked or when a recording you
  answer for pauses); it is refused when the user switched summaries off - then write nothing.
- **Naming a board** (specs/030): every skill and task tool takes the board as `AB#<id>` (the board whose MAIN item is
  that work item; also `<conn>/<id>` or the item's URL), its name or a unique name prefix, or its id - and a cycle id or
  name as before. A bare `#n` is always a **card number**, never a board. When a name matches several boards the tool
  lists them: ask the user which. `AB#<id>` with no board answers "no board has AB#<id> as its main - make one in the
  Team tab" - say so; never open one yourself.
- **Only the user opens a board** - in a board chat, this terminal, or with Start on a work item. `board_open` and
  `team_start` need `askedIn`, the user's message (or "terminal"); never open one because a card, a line or a
  suggestion seems to want it.
- **One recording per project**: `board_record` answers RUNNING when another cycle records the project - ask the user
  to join it or pause it and start a new one.
- **Work items** (the team's tracker, specs/028) are read LIVE through Alfred with the token the user entered on the Team
  tab - `team_search` (text + filters, `mine`, "me", `@current`), `team_query`, `team_item`, `team_items_live`,
  `team_tree`, `team_attachment`. You never hold a token and never ask for one in chat: TOKEN_MISSING means "ask the user
  to enter it in the Team tab". Nothing found is stored. A board keeps its **main** item and the items on its cards as a
  **full copy** (diffed on each sync - `team_board_items`, `team_card_items`, `team_refresh_item`); everything else is a
  **reference**, read live. Mention an item as `@[workitem:<conn>/<id>|AB#<id> <title>]`, a person as
  `@[person:<conn>/<id>|Name]` (`team_people`; "me" is the token's owner).
- **Nothing is written to the tracker without the user's approval.** `team_comment`, `team_move_state`,
  `team_create_item`, `team_link_card` markers and `team_board_link` (without `askedIn`) only prepare a **consent
  bundle** the user ticks, edits and approves on the card or board - say it waits for them; never say it was sent, never
  approve one. No secrets, tokens or raw request bodies in a bundle's text; evidence files are built masked by the user's
  browser. Unlinking is the user's.
- **What arrives from the tracker is a proposal, not a task.** New items in a main's tree, watch rule matches and hook
  pings land in the board's Incoming (`team_incoming`); propose with `team_propose_card` (NEW or LINK, with a reason,
  after `board_similar`), the user decides. An item closed or reopened in the tracker gives its cards a move proposal -
  the user's to accept.

- **Start every run with `task_context`** on the task (no task: it lists them - ask which). It is the whole state in
  one call: the brief, the requirements with the user's marks, the test steps, the findings and who each waits on, what
  the user decided, earlier runs, and the next step. Read more only when it is not enough (`get_brief`, `read_spec`,
  `board_get`).
- **Answer the brief's open comments** (task_context lists them under BRIEF COMMENTS): reply with `board_brief_comment`
  (`replyTo`), ask the user there (`asks: true`) about a passage you are unsure of, and suggest a rewording with
  `suggestFrom`/`suggestTo` (the exact words as the brief has them) - the brief changes only when the user applies it.
  Never resolve a thread; that is the user's.
- **Write everything worth keeping back to Alfred**, never only into the conversation: findings as cards, progress as
  state comments (did / found / next), decisions the user makes as answers on the board, and one `board_session_log`
  entry per run. A fact that is only in this chat is lost to the next session.
- **The brief is the task**, in these sections (the ones that apply):

  ```markdown
  <one line: what the task delivers>
  ## Task
  <ticket id and link, branch>
  ## Description
  <what the user / ticket asked for, in their words>
  ## Scope
  <what is part of it>
  ## Out of scope
  <what is not - never card these>
  ## Test steps
  1. <one action each>
  ## Data
  - <accounts, records, values to follow>
  ## Decisions
  - <what the user decided along the way, with the date>
  ```

  The **requirements** are the Acceptance items of the spec files (the ticket or a spec): each one is checked as met,
  bug, missing or can't tell. "Out of scope" and "Decisions" are binding: never raise what they exclude or settle.
- **Checking the task against what was asked** (review, listen, verify, fix): every Acceptance item has **evidence** -
  the endpoint whose calls show it and the checks each call must pass - and Alfred judges every call to it **in code**
  as it arrives (`board_requirements`; "Requirement status" below). The calls decide, not the code: a call that cannot
  carry what an item needs makes it MISSING whether or not code was written, and code written does not make an item
  met - only a call does. The code is a hint: when the repo is here, read the task branch's change (`git diff --stat
  <base>...HEAD`, then the files that matter) once per run to name the file that misses the item. `/alfred-verify`
  goes further (its "2c"): every Acceptance item's code layer by layer - backend, frontend, database - in every source
  the session can reach, on the task branch, saying plainly which layer it cannot reach, and every open card against the
  code: a To do whose change is already written gets a `board_ask` "Record as fixed?" - `/alfred-fix` records it, verify
  never moves it. Listen does not read code this way, it stays fast. Code the change
  touches that no requirement asks for and no call ran is a NOTE titled `Not in the task: <file> <what it adds>` -
  scope creep or a requirement nobody wrote down; ask, never judge.
- **The Task tab shows what you write** (the cycle page's Task tab and the Board's cycle view): beside each item's
  verdict by the calls, a requirement's state comes from the user's mark, then the cards linked to its Acceptance item (`board_link_spec`: an open BUG = bug, an
  open TASK = missing, FIXED = waiting on a re-test), then your `board_suggest_mark`. So link every bug or missing card
  to the item it breaks, and suggest a mark with evidence for each item you checked - an unlinked card shows only as a
  note, an item with nothing shows "not checked".
- **Picking a task up again** - a new session, another machine, after a break: `/alfred-resume <task>` loads it from
  Alfred and says where it stands as the Task tab shows it, then waits for Go. No `/alfred-*` skills installed
  (another agent)? The MCP prompt `resume` (in Claude Code `/mcp__<server>__resume`) gives the same start.

## 0a. One task, seven stages (specs/030)

Every task goes the same way. `task_context` prints the board's **STAGE** and the exact **NEXT** command - Alfred
computes both from the board (`GET /board/boards/<id>/stage`), so the skills, the board's stage line and Next card,
and `/alfred-guide` always agree. Follow it; never invent another order.

| Stage | When | Next |
|---|---|---|
| 1. Board | the user made it in the UI (New board, from words or a work item) - nothing runs by itself | - |
| 2. Define | no brief yet | `/alfred-setup <board>` drafts brief, spec, steps, data, decisions, evidence AND the cards |
| 3. Triage | Inbox cards, or questions waiting on the user | `/alfred-triage <board>` - with a look at the code per card |
| 4. Code | To do / In progress cards, none Fixed | the user writes it, then `/alfred-verify <board>` |
| 5. Verify | items with no evidence or not found in the code, To do cards with code questions | `/alfred-verify <board>` |
| 6. Test | Fixed cards, or items no call exercised | press Record on the board's Cycles tab, `/alfred-listen <board>` |
| 7. Close | every card Verified / Done / closed and every item marked | `/alfred-report <board>` - one bundle for the main item |

### Defining from a work item - what each item type gives

Read the item with `team_item` (`seed: true`): its own parts, then the parts `children` (every child in full: fields,
repro, acceptance, state, comments; grandchildren as titles) and `parents` (the chain up to the top, each one's
description and acceptance). Page a long part with `part` + `offset` - never stop at the first page, never summarise a
child to its title. TOKEN_MISSING: "Enter your token in the Team tab first" and stop.

**The main item** decides the shape of the board:

| Main item | The board |
|---|---|
| Epic | one section per Feature in the brief (Features read in full, their Stories as titles); offer one board per Feature - the user opens them, you never do |
| Feature / User Story | the usual brief; its Acceptance criteria are the spec's Acceptance items; parents' acceptance is context, never copied as items |
| Task | a brief for that change; its description is the scope; Acceptance items only where the text states a result |
| Bug | the brief is the reproduce scenario; one Acceptance item "the bug no longer happens" with its re-test check, plus any the text states |
| No item (the user's words) | drafted from the words as before; cards only for what the words name |

**Each child** becomes part of the draft - one rule per type, and **every drafted line names its source item**
(`@[workitem:<conn>/<id>|AB#<id> <title>]`):

| Child | Becomes |
|---|---|
| Bug | a **BUG** card: steps to reproduce, expected, actual, the re-test check by the calls, the Acceptance item it breaks (`specItem`), linked to the Bug item |
| Task | a **TASK** card with the task's scope, linked to the Task item |
| Investigation / Spike | its findings under **Decisions** and **Data** in the brief |
| Meeting | its outcomes under **Decisions** (with the date) |
| Test Case | a numbered **test step** (with its expected result) |
| anything else | a line under **Context** in the brief |

- **An Acceptance item no Task child covers** → a TASK card with no Azure item ("Not planned in Azure: <item>").
- **An unclear point** (two texts disagree, a value no text gives) → a QUESTION card.
- **A child Azure shows Completed or Removed** is still a card, its description opening `> [!INFO] Azure says done
  (<state> by <who>)` - triage or verify checks the code; you never skip it.
- **A child the token cannot read** is listed by id under Context: "not readable with the current token".
- **Cards from children are linked to their item on save** (`team_link_card` with `askedIn` = the user's "Save all"
  message and no markers) - no consent bundle at define.
- **An item that is already another board's main**: name that board and stop.

### When Azure moves - refresh and matches

- "↻ Refresh from Azure" on the board (the user's button, or `/alfred-setup <board>` re-run, which reads it first)
  updates the copies with no model and says what changed: new items in the main's tree (they wait in Incoming), items
  Azure moved past (fields, new comments), the main's state or iteration move, and possible card matches.
- **The main closed, removed or moved out of its iteration**: never act on it - propose closing the open cards as
  Not in this flow (`board_propose`), stopping listen, and keeping the board for reference. The user decides.
- **Card matches**: for a card with no Azure item, Alfred proposes open Bug/Task items of the tree that share its words
  or its `/api/` endpoint and were made after the card (`team_card_matches`). Judge each against the card's repro and
  steps and write why with `team_card_matches` `why` - "same endpoint and repro" or "different screen". Only the user
  links one or says "Not this one" (remembered for good); with no match, offer "Create in Azure" on the card
  (`team_create_item`, a bundle under the main item).

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

### Asking the user - questions with options

Ask with `board_ask` `questions` (1-4 related questions in one ask, each with a short `header`) rather than one free
question, whenever the answer is a choice:

- 2-4 options per question; "Something else" is always added for the user. Each option says what you will do if it
  is picked (`then`), mark the one you advise `recommended` (one at most), and give a `preview` when the choice
  changes something the user can see: what changes, what it does to the recorded calls, which acceptance items it
  covers, why. Say in `why` what the answer decides.
- An option whose answer needs one more decision carries it as `followUp` - asked at once when that option is picked.
- Tie the ask to what it is about: `about` = the comment's `[index]`; a question raised by an answer gets `because`
  {entry, header}.
- The user answers some and sends them together; the rest stay open or come back later. Act **only on the answered
  ones** - an open or "later" question is not an answer, and never ask it again. `board_get` shows each question's
  state (`questions: Steps ANSWERED · Checks OPEN`).
- **The user's words decide too** (the waiting bar's Discuss, a comment while the card waits on them). An answer in
  "Something else", or a reply to your question, IS the answer: act on what it says as you would on a picked option.
  A plain comment the user handed to you ("Hands the card to Claude") is an instruction: do it, or ask one question
  if it is unclear. A reply that **asks back** (the question stays open, the card waits on you) gets a `board_reply`
  under it in the same thread that answers it - nothing else; the question goes back to the user by itself.
- A question the evidence or another answer settled: `board_withdraw_question` with the reason, never leave it open
  and never clear Needs decision by hand while a question is open (refused).
- A command started from the board (▶, `board_run_take`) leaves its result on the board: advice the user must act on
  is a `board_ask` on the card, never only text in the chat - the user may not be at the chat. Then end the run; do
  not wait for an answer in the chat.

### Re-test evidence

- A re-test step's `endpoint` is copied from a recorded call (`get_call`), never guessed - `board_retest_plan`
  returns `warnings` for one no call ever hit, with the closest recorded endpoint: fix it at once. Give a step
  `request` conditions when what it tests is in the request ("All Branches" → `$.branchIds` `has:-11`): a call to the
  same path with another body must not tick it.
- Calls before the fix build are not re-test evidence (`beforeBuild`). When every answer of a re-test was empty
  (`emptyAnswers` - 0 rows), the fix was not seen working: say so, add steps whose calls return rows, and never
  propose Verified on it.
- An item exercised with only empty answers is "No data", never "Not exercised"; before writing that nobody sent
  something, `search_calls` for it.
- Answer about code from where the code is: a live answer's prompt says where the card's code links are on this
  machine; when they are not here, say so and give the file:line - never that the code does not exist.

### Writing on the board - readable text

Every text you write on the board (description, comment, reply, question, brief, evidence) is Markdown and is shown
formatted, next to the user's own rich text. Write so the user gets it at a glance:

- **First line**: one bold sentence with the point. Then the detail, a `### Heading` per part when there are several.
- **Tables** for anything compared (before / after, call / status / time); **lists** for steps; `- [ ]` / `- [x]` for a
  checklist the user can follow.
- **Code** in a fenced block with its language - ` ```sql `, ` ```json `, ` ```java `, ` ```diff ` (a proposed change),
  ` ```log ` (a stack trace). A body is whole, never cut.
- **Callouts** for what must not be missed: `> [!NEXT] Deploy, then re-test`, `> [!WARNING] ...`, `> [!BUG] ...`,
  `> [!FIXED] ...`, `> [!INFO] ...` (title on the first line, more lines with `> `).
- **Fold** long evidence so the comment stays short: a line `+++ All 12 statements`, the content, then `+++`.
- **Pills** for a state: `[ok]`, `[fail]`, `[wait]`, `[info]`, or with words `[fail: 405 × 5]`. `==highlight==` one key
  value; `~~struck~~` for what is no longer true.
- **Variables**: `{{name}}` for a global variable (a URL, a branch code) - the board shows its value in the active
  environment; never paste a secret's value.
- **Mentions in a table cell** work as written - `@[call:in:<id>|label]` needs no escaping (an escaped `\|` is read too).
- **A call alone on its line** (`@[call:in:<id>|POST /orders · 500]`) shows as a call card; inside a sentence it is a
  pill. Pictures the user pasted are `![...](/board/images/<id>)` - open them with `board_image` before you judge.
- **Language**: answer in the language the user wrote in; Arabic and English mixed in one text is fine (each paragraph
  takes its own direction). Keep code, paths and identifiers in English.
- **Readable references** (specs/021): the reader was not in your session. Never leave a bare code they cannot open -
  `AC8`, `#47`, "calls #75, #81", `[6]`, a call id, NO_DATA, REQUEST_WHEN. Say what a thing is in words, or mention it:
  the board tools write `AC8`, `#47`, "call(s) #N", `[n]` and call ids as their mentions with their meaning before saving
  ("one-branch search (AC8)", "All Agencies untested (#47)", "POST refunded-requests/search · 200 (call 75)", "your
  answer · 4:38 PM") and the reply lists what they converted and what they could not find (`notFound`) - fix those in
  words. Verdicts, check names, app starts, listen batches and run ids have no page: write them as words ("every answer
  was empty", "counts only calls that send one branch", "the app restart at 9:14"). A card title leads with its plain
  meaning.
- **Short names**: give every card you add a few words (`board_add` / `board_add_many` `shortName`, e.g. "All Agencies
  untested") and every Acceptance item you write evidence for (`board_short_name` with `ac`) - every mention of it reads
  them. `board_requirements` says "(no short name)" where one is missing. You name only what has none; the user changes it.
- **Reactions**: the user's ✅ on your plan or question means **Go** - carry on without asking again (`board_changes`
  shows it as `= GO`). An edited comment (`edited a comment; it now reads`) replaces what it said before: act on the new
  text.

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

Every call of the flow is checked (OPTIONS preflights, static files, health checks and 304s aside): status, response
body, its log lines, its SQL, its outbound calls, its Redis commands, and the spec item the step belongs to (the
items a step names say which calls are its; the user's comments may add more - spacers are not used). `check_calls` does the checking ("Batches" below); you decide what each
flagged call is, with the lines just before an error (`log_context`) and the statement (`db_statement`) when needed.

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
  you could not make ("▤ log capture is off for <project>"). A **missing feature** - a call that cannot carry what an
  item needs, or an endpoint still answering the pre-task request - is a TASK `Missing feature: <item>` that Alfred's
  requirement check opens itself, in code, from the first call that shows it (BUG `Wrong result: <item>` when the
  request is right and the answer breaks the item): link to it, never open a second.
- **QUESTION** flagged NEEDS_DECISION - the spec and the behaviour disagree and you cannot tell which is right: ask it
  with `board_ask`.
- **NOTE** - worth knowing, nothing to fix (flag AFFECTS_PROJECT when shared code is involved).

### Requirement status - each Acceptance item by the calls

Alfred keeps each item's **evidence** (`board_evidence_put`: endpoint + checks) and judges every call to that endpoint
in code, once, as it arrives - flagged or clean, with no model. Checks apply in this order: `REQUEST_SHAPE` (what the
request must be able to carry), `REQUEST_WHEN` (which calls exercise the item - others are about another choice),
`STATUS` / `ROWS_MATCH_FILTER` (what the answer must be), `ROWS_PRESENT` (rows to prove it). The item's verdict is the
worst among its calls since the app last started or its card was fixed:

| Verdict | Meaning | What happens |
|---|---|---|
| MISSING | a call cannot meet the item (one `branchId` where several branches must fit) | Alfred opens TASK `Missing feature: …` at once (one card for the items one missing capability blocks) |
| WRONG | the request can, the answer breaks it (a branch leaks into a multi-branch search) | Alfred opens BUG `Wrong result: …` |
| MET | a call exercising it passed every check | a card about it is told; you propose Verified / Done, the user decides |
| NO_DATA | the right request, no rows to prove anything | a QA task for the test data (at finish) |
| UNKNOWN | a body not JSON, a wildcard naming two fields | find out why; fix the evidence |
| NOT_EXERCISED | no call matched yet | a TASK at finish, with the item's howTo |
| MANUAL | UI only (`UI` endpoint) | check it in the frontend code ("met by code", a suggestion) or ask the user |
| NO_EVIDENCE | none written | draft it (`board_evidence_put`) |

A step is SEEN only when its items' calls pass; a step whose item is MISSING or WRONG is FAILED with that card. The
user's mark always wins over a verdict; an item whose card the user closed as Fine is never carded again.

### Batches - how listen and review check calls (one procedure, the same accuracy)

Never check calls one tool call at a time: Alfred checks every call in code, you judge what it flags.

1. **`check_calls`** on the cycle - with `sinceCallId` (the previous reply's `lastCallId`) for a batch, without it for the
   whole cycle. Every call is checked, none skipped: status, errors inside 200s, empty results, ERROR / WARN lines and
   exceptions, failed and flagged SQL (N+1, slow…), failing supplier calls, Redis, slow against the same endpoint, and
   the **hop diffs** (`Δ`) of the flows the calls carry. It lists every other call as clean and says which are still
   running (`pending`, checked next time - pass its `lastCallId` on). A call that has run for minutes with no end is
   passed over: it is listed as never completed (`stale`) and is a flagged group once - judge it; when it does finish
   it is the next batch's. A call checked before its log lines, statements or supplier
   calls arrived is re-judged by the next `check_calls` once they do (`rechecked`); while `recheckPending` > 0, call it
   again even with no new calls - that is how a batch never misses an ERROR that came a second late.
2. **Groups, not calls.** Flagged calls come in groups: the same problem on many calls (same endpoint, exact status,
   signals, ERROR / WARN text, failing supplier outcome, DB flags, failing statement, hop-diff keys) is one group
   `G1 · 512 calls`, with one example's evidence and every member listed (`callIds` and a stable `key` in the JSON).
   A call with anything different is in another group, so a group never hides a second problem. Judge each group once.
   More groups than fit → the reply's `next`: call again with `offset: next` and `untilCallId` = its `lastCallId` (the
   same `sinceCallId`, or the same `sweep`), until `next` is null - never stop at the first page; the pages are one batch,
   frozen when its first page was made.
3. **Judge only the flagged groups**, with "What becomes a card" and "Flows". Drill in only when the evidence is not
   enough: `investigate_call`, `log_context`, `db_statement`, a body field with `get_call` `paths` - never whole bodies
   by default. Read an endpoint's code once per run (`codegraph explore "<handler> <mapper>"` when the repo has a
   `.codegraph/`, else `locate_source` + the files).
4. **Write in bulk**: `board_similar` / `board_for_call` once per finding, then every new card of the batch in one
   `board_add_many` - each with its `firstComment` (the first state comment) and its `specItem` (the Acceptance item it
   breaks), so no card needs a second or third call; a group's card links **all** its calls. One state comment per
   existing card per batch.
5. **The ledger.** Every group ends as exactly one of: a **card** (new), a **link** to a card (`board_link`, all its
   calls), **asked** (in a `Learn:` card), or **fine** - with the reason (a project check, an `allowed` line, a closed
   card, "a 404 the user caused on purpose"). Keep the ledger as you go; never leave a group without an outcome.
6. **Clean calls need nothing** - except the test steps they show (`board_mark_step`).

**The sweep.** Before stopping listen, `check_calls` with `sweep: true` (all pages): it re-judges only the calls never
checked or whose mark changed since (a late log line, a statement that settled after its batch), and the calls whose
writes arrived late come back with their hop diffs - give each new group its outcome. Review checks the whole cycle in
one pass already and needs no sweep. The session log carries the count:
`120/120 checked · 9 flagged in 4 groups · 3 cards · 1 linked · 0 fine`.

### Flows - learned from the calls and the code

All 200s and a finished flow are not a pass. Most real bugs live between steps: a value one step hands to the next
changes or disappears and every status stays fine. You find what must hold yourself, from the calls and the code, ask
the user only what you cannot tell, and keep the answers - in any project, whether or not the spec mentions it.

**Find the flows.** A flow is calls linked by what they carry: a value in one call's response that comes back in a
later request, in our outbound supplier call, or in a database write (search → confirm → book, cart → checkout →
order, list → edit → save). `check_calls` finds them for you ("Flows", linked by their ids) and lists every value that
changed, went missing or changed count between them (`Δ`), with both calls, paths and values. It matches by key name,
so a value our side and the supplier name differently (`departure` / `dep.at`) is compared by you, from the code. Name
the flow after what it does (`booking`, `profile edit`) and use that name everywhere: cards, questions, project checks.

**Read the code.** The session always runs in the app's repo. On the first call of each endpoint in a run,
`locate_source` for its handler, then read the handler and the mapping it calls (to the supplier, to the response, to
the database) - **once per endpoint per run**, reusing what you learned. The code says what happens to each carried
value: copied through, recomputed, re-fetched from the supplier, converted (time zone, currency, format). It never says
what is right - a mapping that drops a field is the bug, not the expectation.

**Make an expectation per carried value** - IDs and references, dates and times, amounts and currency, names, codes,
counts, lists of items or people. Skip what is meant to change: per-request ids, trace ids, tokens, nonces, the call's
own timestamps.

- **Sure** - a project check covers it (below), a spec item says it, or the code copies it through untouched. Break it
  → a card (below).
- **Unsure** - the code changes it on purpose (re-fetch, conversion, a rule), the code is not clear, or the data and
  the code disagree in a way that could be intended. Never a BUG card on a guess: it goes into the flow's question.

### Flow consistency - compare at every hop

For every sure expectation, compare the value at every hop - response → next request, supplier answer → our response,
request → our supplier request, what the user confirmed → the saved row (INSERT / UPDATE parameters). Start from
`check_calls`' `Δ` lines; add the hops it cannot match by name yourself.

- A value that changed with nothing announcing it → **BUG**.
- A value that disappears between steps (present in the response, missing from the next request or the saved data) →
  **BUG**.
- A response that is right over a row that is wrong → **BUG** (Database or Backend).
- A change the supplier announced (repricing, schedule change, availability) that never reaches the user →
  **QUESTION** flagged NEEDS_DECISION, unless a project check says how it must be shown.
- Evidence: both calls, the field with its old → new value (`fare.total: 412.00 USD → 437.50 USD`), and the code line
  that sets it when you read it (`@[code:...]`, "likely cause - not verified"). The first call where it differs is the
  main link.
- Teams by where it changed: the supplier answered differently from one step to the next → Integrations; the supplier
  answered the same and our response or our next supplier request differs → Backend; our response was right and the
  browser sent something else back → Frontend; the saved row differs from the request → Database or Backend.
- One card per value that drifts in one flow, not one per call; the same drift in later runs → `board_link` to it.

### Learning - ask once, keep the answer

- **One question card per flow**: a QUESTION flagged NEEDS_DECISION, title `Learn: <flow> - what must stay the same`,
  teams QA. Before opening one, `board_search` for it - while one is open for the flow, add to it (`board_ask`), never
  a second card.
- **One batched question**, numbered, only the unsure items (at most 5 at a time), each with what you saw and what you
  will do by default:

  ```
  Flow booking (search → confirm → book). I see:
  1. fare.total: 412.00 → 437.50 at confirm; the code re-fetches it (PriceService.java:40). May it change here,
     and must the user be told? @[call:in:...]
  2. passengers: 2 in the book request, 1 in our OrderCreate @[call:out:...]. Must the supplier get every passenger?
  By default I treat 2 as a bug.
  ```

- **Answers** arrive on the board (`board_wait`, `/alfred-sync`). Each answer becomes a project check line. A "must"
  answer about something already seen → open the BUG card now, with the calls from the question.
- **The user's decisions teach too**: a card closed as Fine, or Not in this flow, about a flow value → offer an
  `allowed` check line, so it is never reported again.
- **Save the checks** (below) at the end of the run: one before / after of the new lines - answers, allowed lines,
  sure expectations you read in the code - and save only on yes. Never ask what a check or a closed card already
  answers; an unanswered question gets one reminder after a day, not a new card.

### Good runs - the reference, found and confirmed

A run of a flow is **good** when every check of the flow holds in it and no BUG card is open on its calls. When you see
one, propose it - in chat while the user is there, or as one item of the flow's question ("Is `ODY-482 run 3` a
correct run of booking? I will compare later runs with it."). Only a run the user confirmed becomes the reference: a
`good run` check line. Review compares later runs of the flow with it ("Shape regressions"). A new confirmed run
replaces the old one; a bug later found in the reference → propose the next good run.

### Project checks - what the project has learned

The repo's `CLAUDE.md`, section `## Alfred checks`: one line per check, the flow first. It is the memory of everything
learned above - versioned with the code, shared through git, read at the start of every run.

```markdown
## Alfred checks
- booking (search → confirm → book): departure, flight number, passengers unchanged at every step
- booking: fare.total may change at confirm (re-fetched); the change must reach the user
- booking: the booking row holds the fare the user confirmed
- allowed: booking - arrival may come back without seconds (closed #14 as Fine)
- good run: booking - cycle "ODY-482 run 3"
- every call: amounts in a response carry a currency
```

- Read it at the start of every run, with the brief. Each line works like an Acceptance item of every cycle: broken →
  **BUG** (URGENT); not exercised in this cycle → no card (only spec items get a TASK for that).
- Mention the check in the card (`Alfred checks: booking - passengers unchanged`).
- Never write the section without asking; when the user agrees, add or change only the lines they approved, showing
  the before / after. Never remove a line the user wrote - propose the change in a question.

When logs cannot be read (▤ off, or the level above WARN), say so on the card and offer once to turn it on
(`set_log_capture`) - change it only if the user agrees, then report old → new. The same for ◆ database capture.

## Interception rules - you propose, the user switches

You can **create** an interception rule; you can never switch one on or off, edit or delete it, touch the master switch
or paused calls - the backend refuses all of it, and you never ask the user to let you.

- Create one only to **reproduce a bug** (the supplier answers 500, is slow, times out, sends a body without a field)
  or to **check that a fix handles the failure**. Never to "try something".
- Build it from a logged call: `rule_from_call` → `rule_preview` (a handful of matches, not the whole flow; none means
  the match is wrong) → `create_rule` with a recipe from `rule_recipes`, a name that says what it does ("Galileo
  search → 500"), the reason, and the card it reproduces.
- It is saved **off**, under "Proposed by Claude". Tell the user what it does and ask them to switch it on - suggest
  "on for 30 min" - then run the flow. Never say or assume a rule is on: `list_rules` tells you.
- When the user ran it, `rule_hits` shows the calls it touched; write the result on the card (`board_comment`: what the
  rule did, what the app did with it) and remind them to switch it off if it has no time limit.
- A rule must stay narrow - a host or project AND a path, no pause; the backend refuses anything else.

## Visuals - show it, keep it alive

A picture of the evidence beats a paragraph, but the words come first: every comment or brief still opens with its
one-line summary in text; a visual backs it up.

- **Markdown, HTML, or both in one text** - write whichever says it best, mix them freely (a sentence in Markdown, then
  an HTML table, then a Markdown list). Alfred's tools turn every text into board text before it is saved:
  - HTML the board draws itself - `<p>`, `<h1>`-`<h4>`, lists, `<table>`, `<blockquote>`, `<details><summary>`,
    `<aside data-callout="bug|warn|info|ok|next">`, `<b> <i> <u> <s> <mark> <code> <kbd> <a> <br>`, colour
    `<span data-color="red|green|amber|blue|purple">` (or `style="color:…"`, mapped to the nearest), pills
    `<span data-pill="ok|fail|wait|info">`, board images - becomes the same board text the editor makes. Class and
    other style attributes are dropped: the board's own look, light and dark, applies.
  - HTML with `<script>`, `<style>`, `<svg>`, `<canvas>`, form controls or an `<iframe>` becomes a ```` ```html live ````
    snippet as you wrote it, running in the locked frame. The reply says so: check it with `board_snippet_view`.
  - Mentions (`@[call:in:…|label]`), `{red|text}` and pills work inside HTML too. HTML inside a code fence stays code.
  - Motion (`animation`, `transition`, `transform`) runs only in a snippet: a `<style>` with `@keyframes`, SVG
    `<animate>`, a `<script>`, or a `style="animation:…"` attribute all make the part a snippet. `board_snippet_view`
    shows one still frame - check the console, not the motion.
- **Which to use**:
  - **Markdown by default** - sentences, lists, simple tables, mentions, `{red|…}`, callouts, fixed blocks. Shorter,
    diffs cleanly, and the next session reads it easily.
  - **HTML when Markdown cannot say it** - a table cell spanning rows or columns (`colspan`/`rowspan`), several
    paragraphs or a list inside a cell, callouts or folds nested in each other, content that is already HTML.
  - **HTML with script/style/SVG** only for a custom interactive, drawn or animated view a fixed block
    (```` ```chart ````, ```` ```stats ````, ```` ```calls ````) cannot give - fixed blocks are cheaper and read live data.
- **A fixed block** when the board can draw it: ```` ```stats ````, ```` ```chart ````, ```` ```timeline ````,
  ```` ```mermaid ````, `[progress: 3/9 …]`, `:::tabs`, `{red|text}`. Cheap, exported as text, always the first choice.
- **Live data, never pasted numbers**: ```` ```calls ```` (`endpoint`, `since: fix`, `show: chart(durationMs)`),
  ```` ```sql ````, ```` ```logs ````, ```` ```compare ````, `!@[call:in:…]`. They re-read as calls arrive; numbers
  you paste go stale.
- **A snippet** (```` ```html live ````, ```` ```python live ````, or a page with `board_page_put`) only when a fixed
  block cannot say it - an interactive view, a join of several sources. It runs in a locked frame with no network:
  read data with `alfred.data()`/`alfred.watch()`, keep choices with `alfred.state`, load only what `board_lib` lists.
  Files you attach (`board_attach`) are read with `alfred.files(name)`.
  - Write `<script type="module">` (own scope, top-level await) and read the data in it - `await alfred.calls()` is the
    calls of the cycle it is shown for. Never hand-draw SVG with computed coordinates or paste rows into code.
  - The frame has a design kit and a theme: `.grid`, `.card`, `.kpi` (`.label .value .note`), `.badge.ok|warn|err`,
    `.bar` (`--v`), `.chart` (`--h`), `.table-wrap`, `td.num`; ECharts, Chart.js, ApexCharts, Plotly, Observable Plot and
    Mermaid are dark-themed with one palette already (`alfred.palette`, `alfred.colors`) - set no colours unless they
    mean something; format with `alfred.fmt.ms|num|pct|time|bytes|path`.
- **Check it before you say it is ready**: open it once on the board, then `board_snippet_view` - read the picture and
  the console. An error in the console means it is not done.
- Pin a page to the top of a card only when it is the card's dashboard (`board_pin`); save a view the project will
  reuse as a widget (`board_widget_put`) and tell the user the `{{widget:name}}` line.
- Buttons and forms (`[choose: …]`, `[action: …]`, ```` ```form ````) only ask - the user clicks, and every change shows
  a consent dialog first. Never write one that does what the user did not ask for.
- A question asked from a snippet or the editor's ✦ reaches you as `/alfred-ask <id>`: `board_ask_get`, then
  `board_ask_answer`.

## Board chat - answer once, record what lasts

The board has chats (specs/022): one per project, answered by the project's live runner, and one per session cycle,
answered by the terminal session that ran /alfred-live for it - that session itself, never a copy, and the comments on
the cycle's cards too. The runner hands you a message (a `✉` line in the terminal); you never poll for one. A closed
terminal means the messages wait: Alfred never starts or resumes a session itself.

- `chat_take` first (the runner does it), then **one** `chat_reply` per message. Read the thread and the chat's latest
  summary the take gave you; `chat_read` for an older message or an earlier answer, `chat_summary` when the runner asks
  you to compact (cover only what came before the first message still waiting).
- **Records** - a reply carries one only when the answer changes something another session needs:
  - `DECISION` - the user decided something ("keep the old endpoint") - appended to the cycle brief, ★ in the chat.
  - `NEXT` - the next step changed - appended to the brief's next step.
  - `CARD` - a new problem worth tracking - an Inbox card as you, the same limits as `board_add`.
  - `ITEM` - a new acceptance item - a proposal on the spec file, never written into it.
  - `FIX` - you changed code for a card - a Did/Found/Next comment and the card moved to Fixed.
  - None for plain questions and answers. Every record has Undo for the user; never repeat one they undid.
- **Final answers only** in a cycle chat: the steps between two answers stay in the terminal session. Alfred keeps
  the messages, the final answers, what needs the user (a question, a proposal) and the records. A decision needed
  mid-task is a reply that asks it; the job pauses until the answer arrives as a new message. Long output goes to a
  file or a board page, linked from a short answer.
- **To the terminal** (`toTerminal` on the reply, the project chat only - a cycle chat IS the terminal): only what the
  terminal session must know before its next step. Mark it urgent only for a decision that contradicts what the
  terminal is doing, files you changed, or the user writing `@terminal`. Everything sent is masked like the export.
- **Lines the terminal session sees** (written into the runner's chat log, read by the session that works in the
  terminal):
  - `✉` - a chat message or a card comment for this session to answer (see the alfred-live skill).
  - `↪ handed over` - another terminal session answers the cycle now: stop watching.
  - `⚡` - an urgent line from the board chat: act on it before the next step, or say why not.
  - `💬` - context from the board chat: read it, do not stop for it.
  - `↳` - a comment the chat already answered: do not answer it again.
- Watches (`chat_watch`) wake the chat when an acceptance item passes, a card's status changes or an ERROR line is
  caught - never a timer. `chat_mirror` copies a terminal exchange into the chat when the user asks for it.
- A chat answer follows every other rule in this file: evidence by mentions, no invented numbers, Claude's board limits.
- **Opening a board from a chat** (specs/027): only when the user asks in that message - "open a board for AB#1234",
  "open a new board <name>". Never on your own, never because a card or a line suggests it.
  - "open a board for AB#<id>" (or `<conn>/<id>`): `team_item` first (live). TOKEN_MISSING: reply "Enter your token in
    the Team tab first" and open nothing. It is already the main item of a board (`inAlfred`): reply with that board and
    open no second one. Else run /alfred-setup for it here, `askedIn` = this message.
  - "open a new board <name>": `board_open` with `askedIn` = this message and `relateTo` = this chat's board (unless it
    is the project's default board); then offer /alfred-setup for its brief.
  - A `/alfred-setup <conn>/<id>` message is the user's Start button: run /alfred-setup for that item.
  - A line from Alfred suggesting a board for a new work item is not a request: the user answers it with Yes (which
    starts it) or No. Do not act on it.

## Streamed items - other Alfreds' cycles and boards

Alfreds on the LAN stream cycles and boards to each other (specs/035). A ref ending `@<tag>` - `8f1c…@stg-83` - is
another Alfred's cycle, board, card or call; `links_streams` lists what is streamed to this Alfred and out of it.

- **Read them like local ones.** Every read tool takes the ref: `get_cycle`, `check_calls`, `investigate_call`,
  `db_statements`, `call_logs`, `board_get`, `task_context`. The data is read live from its owner, masked there.
  Nothing of it is kept here - quote what you need into this Alfred's own cards (the call's facts, never its bodies).
- **Work them on this Alfred's boards.** A streamed cycle on a board here is listened to, reviewed, re-tested and
  judged like a local one; cards opened from its calls are this Alfred's cards, mentioning the remote call.
- **Never write on their things.** A comment or a question on another Alfred's card, a comment on its brief, a note on
  one of its calls: `links_request` - a request its owner (a person) accepts or rejects. A view-only stream allows none.
  Requests asked of THIS Alfred are the user's to answer - never accept or reject one yourself.
- **Offline is a state.** When an Alfred cannot be reached, say so (`⇇ STG 83 is offline`) and answer from what you can
  read; never guess its data, never fill the gap from an older read.
- **Environments.** A board may be tested on several Alfreds (Local, STG, UAT…). On the host, the Task tab's matrix shows
  every environment's column; each column is written only by its own Alfred. When THIS Alfred is an environment of
  another's board, `env_boards` shows its column: mark items from this Alfred's calls (`env_mark`, with evidence), tick
  steps (`env_step`), re-test the Fixed cards (`env_retest`) and, when the user asks, record a test cycle for it
  (`env_record`). Never mark the host's own column.

## 5. Every run

- First call: `task_context` (rules §0). Last call: `board_session_log`.
- Keep the live strip current: `board_status` with `step` ("reviewing ODY-482 · 34/120 calls") while you work,
  STOPPED when you stop. If it answers `paused: true`, stop adding cards and tell the user.
- End every run that touched a cycle with **one** `board_session_log` entry (skill, did, found, next).
- `--dry` in the arguments: do everything except writing - list the cards, comments, brief or spec changes you would
  make, and stop.
- Commit only when the user asks. Run the project's tests before saying a fix works.
- No subagents - do the work in this session.
- Finish with a short summary and the next command to run (`/alfred-...`).

## The flow

(`/alfred-connect` once per instance) → New board (the user, in the UI) → `/alfred-setup <board>` (define, with cards)
→ `/alfred-triage <board>` → code → `/alfred-verify <board>` → Record + `/alfred-listen <board>` while testing (or
`/alfred-review` after) → `/alfred-sync` ↔ `/alfred-fix` → `/alfred-verify` → `/alfred-report <board>` (close). `/alfred-spec`
for a targeted edit of the brief or spec; `/alfred-status` and `/alfred-guide` anytime. The stage table (§0a) says
which comes next.
