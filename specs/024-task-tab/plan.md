# Task tab redesign - plan

Mocks: `mock-task-redesign.html` (before / after), `mock-task-interactive.html` (every control working on mock data).
The tab itself is frontend only; brief comments add a table, REST routes and an MCP tool (below).

## Outcome (2026-10-16)

Built as planned: `TaskViewComponent` (header, Needs you, tabs, guides), `TaskRequirementsComponent` (the one list; the
old `AcceptanceChecklistComponent` is removed), `BriefCommentsComponent` + `brief-highlights.ts` (CSS Custom Highlight
API), `CycleBriefComponent` restyled with the margin; backend `BriefCommentService` / `SqliteBriefCommentRepository` /
`BriefCommentController`, import of `briefComment` records; MCP `board_brief_comment`, comments in `get_brief` and
`task_context`; rules.md tells the skills to answer open threads.

## Shape

1. **Header** (`task-view.component.ts`): ticket / branch chips, title, phase stepper (done steps ticked), the verdict
   in one line with a segmented bar (met / Claude suggests / bug / missing / re-test / can't tell / not checked).
   Right: the **primary button** - the phase's next skill in plain words ("Check while I test" = /alfred-listen,
   "Hand-over report" = /alfred-report when Done-when is green, "Write the requirements" = /alfred-spec when there are
   none) - and a **Run ▾** menu with every skill (plain words + the command to run or copy) and "Continue anywhere".
2. **Needs you strip**: cards waiting on the user (today's side box), Claude suggestions to accept, requirements to
   judge, test steps left - each jumps to its tab or opens its card.
3. **Tabs**: Requirements (default) · Test plan · Brief · Claude's runs · Spec & files; the tab is kept per cycle in
   this browser.
4. **Requirements**: one list built from `requirementsOf` + the checklist's call verdicts (the acceptance checklist is
   folded into it - no second list). Filter chips = today's tiles. Groups: Decide (Claude suggests), Bug, Missing,
   Re-test, Can't tell yet, Not checked, Met (folded), Also found (notes + not in task). One row each: state, Rn + text,
   cards, a short call pill (0 rows / no call yet / checked by hand, reason on hover), one Pass / Fail / Can't tell
   control. A row opens to: your evidence (edit), Claude's suggestion (Accept / Dismiss), the calls' verdict + why,
   From file, and evidence · checks (the checks editor) · ask.
5. **Test plan**: steps + test data (left), Done when + the report button (right).
6. **Brief**: `app-cycle-brief` restyled - goal, description beside scope / out of scope, decisions as a dated list,
   other sections, pinned / pages / files in one row, edit / restore. "Continue anywhere" moves to the Run menu.
7. **Claude's runs**: one line each (skill · when · its Next), newest open; Did / Found / Next as blocks.
8. **Spec & files**: `app-spec-files` + the cycle's files.

## Section guides (new)

- Every tab has "ⓘ How this works": what the section is, where its data comes from, and how to decide in it. Open the
  first time a tab is seen, then remembered closed per tab (localStorage, try/catch).
- Requirements' guide: what each state means (Met, Bug, Missing, Re-test, Can't tell, Not checked, Claude suggests) and
  a decision guide per situation (Claude suggests → read and Accept; 0 rows → add data and search again; no call yet →
  do the Test plan step while Claude listens; saw it work → Pass + evidence; saw it wrong → Fail; can't be shown →
  Can't tell with a note).
- ⓘ hints (hover / tap) on the verdict, the stepper, the next-step button, Needs you, each requirement group and every
  call pill (0 rows, no call yet, checked by hand) - same words as the guide, one shared source in `task-view.ts`.

## Brief comments (new)

- **Where**: the Brief tab's margin. Select text in the brief → 💬 Comment (anchored: the quote and its section are
  stored, the passage is highlighted; hovering a highlight lights its comment and back) or "+ On the whole brief".
- **A comment**: text (rich, mentions), replies (the card comments' tree and editor are reused), Resolve / Reopen;
  resolved ones fold under "N resolved". A quote no longer in the brief (it was edited away) shows "passage changed"
  and stays readable.
- **Claude**: reads open brief comments in `task_context` / `get_brief`, replies, can ask (❓ shown on the comment and
  in Needs you), and can suggest a rewording of the commented passage - the brief changes only when the user clicks
  Apply (the edit goes through the brief's normal save, so Restore previous undoes it). Claude never resolves.
- **Counts**: open comments on the Brief tab label and in the Needs you strip (when Claude asks).
- **Backend** (`backend-board`): table `brief_comments` (id, cycle_id, quote, section, text, actor, reply_to,
  answers, resolved_at, resolved_by, suggestion, created_at, edited_at) in board.db, REST under
  `/board/cycles/{id}/brief/comments` (list / add / reply / edit / resolve / reopen / apply-suggestion), the /ws/board
  signal on change, Claude's limits as for card comments, included in the board .json export / import, deleted with
  the cycle's brief. MCP: `board_brief_comment` (add / reply / ask / suggest) and the comments in `get_brief`.

## Not changed

Every action and API call of today's tab (marks, accept / dismiss, evidence, checks editor, ask, card links, brief
edit / restore, spec upload / restore / delete, pages, files, pinned, run-skill), live refresh on /ws/board.

## Tests

task-view spec (header verdict + bar, primary action by phase, merged list groups + filters, one mark control,
row details), acceptance-checklist logic reused not duplicated; full frontend suite + production build; browser
check on cycle 61813 (view only).
