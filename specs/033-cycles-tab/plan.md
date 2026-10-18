# specs/033 - The board's Cycles tab, redesigned

The tab today: a chip row (moved from the header by specs/032 D11) and a three-column table - name, status, created.
It says nothing about what a cycle caught or whether it passed, and most of what can be done with a cycle needs the
Session Cycles page. Prototype: `prototype.html` (sample data, every button works).

## What the tab shows

- **Header**: cycles, calls, failed calls, requirements met (this board's acceptance items, best cycle); **● Record**
  split button (new cycle / re-test cycle / join the project's running recording); **＋ Add existing cycle**.
- **Toolbar**: search (name, endpoint), filters All / Recording / Re-tests / With failures / Shared, sort (newest, oldest,
  most failures, most calls).
- **One row per cycle, three short lines when closed** (the chip row and the table become one list): the name; one
  line of facts - ● REC / duration, ↻ re-test, the cards as number chips coloured by their verdict (#76 ✓ #81 ✗ #83 ?),
  calls · failed, AC met/total, the status strip; the description's first line. Only Pause/Resume and ⋯ are buttons;
  the name opens the cycle; a click on the row opens it in place with three sub-tabs - **Overview** (description,
  cards with titles and verdicts, facts: times, SQL/log counts, assignee, other boards), **Calls**, **Requirements**.
  What a row holds in full:
  - status dot (pulsing while recording), name - rename in place, badges: ● REC since, ↻ re-test · N cards, shared · N
    boards, assignee;
  - its **description** (first lines; "add one" when empty) - what the cycle is for, the steps, what is expected;
  - its **cards**: a re-test shows "Tests" - each card it re-tests with the card's status and its verdict in this cycle
    (✓ passes / ✗ still fails / ? not reached yet); a recording shows "Found" - the cards made from its calls (with the
    call they came from); ＋ card links another;
  - facts: start → end (duration), calls · endpoints, last call, ◆ SQL / ▤ log line counts;
  - this board's requirement verdicts on it (met / wrong / not seen), a status strip of its calls in time order,
    failed-call count, the cards that mention its calls; a re-test shows "vs previous: …";
  - actions: ⏸ Pause / ● Resume, Open, ▸ Details, ⋯ (verdicts per call, ask Claude to check it, export .md/.json,
    assign, re-test from this, compare with the previous one, remove from board, delete).
  - ▸ Details: the description in full, editable (who wrote it and when; ✦ Draft with Claude fills it from the cards
    and the calls for the user to save), the first calls (time, call, status, ms) with "All N calls →", the requirements one by one, the other
    boards it is on.
- **Re-test cards…** (from ● Record ▾): pick the cards to re-test (Fixed cards ticked), and the cycle is **named after
  them** - one card: `Re-test #76 · <card title>`; several: `Re-test #76 #81 #83 · 3 cards` (`+N` past three) - and
  linked to each, so every card shows this re-test and its verdict. The name stays editable; a description is
  prefilled from the cards' re-test plans (✦ Draft with Claude). A plain recording is named `AB#59851 · rec <time>`.
- **Select several** → Compare, Export, Ask Claude, Remove from board.
- **Compare** (two cycles): calls, failed, median time, SQL statements, requirements met, endpoints only in one,
  endpoints whose status changed; ✦ Ask Claude why (a board chat message).
- **Delete** says what is kept (the delete plan: calls board texts mention) before it deletes.
- **Related boards** stay a small section under the list.

## Enhancements (all in the prototype; its legend says where each one is)

1. **Verdict timeline per card** - a click on a card chip: every cycle that checked it, oldest first (✗ 12:01 → ? 12:32 →
   ✓ 13:16), Open card, ↻ Re-test it.
2. **Ready to re-test** - one line above the list when a card became Fixed after the last re-test that tested it;
   "Re-test it" opens the dialog with those cards ticked.
3. **Pause suggestion** - on a recording re-test, once every card it tests was checked: "Pause the recording?"
   [Pause] [Keep recording].
4. **Steps from the description** - lines `- [ ] …` become steps that tick themselves when a call matches (the
   acceptance-item evidence rules); the user can untick.
5. **Story** sub-tab - the calls grouped by spacer (else by pauses between calls), the failing step open, the failing
   call with why (exception, ERROR lines) and ▤ logs / ◆ SQL one click away (`call_story`, `layoutSpacers`).
6. **Diff vs baseline** - "vs baseline: …" on each row opens Compare: totals, status changed, slower by > 50%, response
   shape changed, endpoints only in one.
7. **Hot spots** - the three worst endpoints of the cycle; a click filters the Calls sub-tab.
8. **Ask about this cycle** - a box under Overview; the message goes to the board chat tagged with the cycle.
9. **Claude's summary** - written when a recording pauses, under the description (never in it); edit, remove, or
   "Stop Claude's summaries here" for the board.
10. **⚑ Baseline** - one per board, set from ⋯; Compare and "vs" use it, else the previous cycle.
11. **Environment** - a tag from the calls' host (env 80, STG), an Environment filter.
12. **Archive** - hides a cycle and keeps everything; "N archived" at the bottom; Delete offers Archive instead.
13. **Evidence pack** - one file (.html / .md / .json) with description, steps, card verdicts and every failing call in
    full, credentials masked; optional attach to the Azure item as a consent bundle.
14. **Keyboard** - ↑ ↓ move, Enter open, Space select, o open page, ? the list, Esc close.
15. **Live counters** - a recording row's calls, failed and strip move as calls arrive (the existing signal, no poll).

### Kept quiet - the rules each one follows

- Nothing opens by itself: no popup, dialog or toast unless the user clicked. Suggestions are one inline line.
- Every suggestion can be dismissed and stays dismissed: the re-test line returns only when another card is fixed;
  the pause line shows once per cycle; Claude's summaries can be switched off for the board.
- Claude never changes the user's text (description, name) - it drafts for the user to save, and writes its summary
  in its own block, marked as Claude's.
- Nothing automatic acts for the user: no auto-pause, no auto-archive, no auto-attach - each is a button.
- A closed row stays three lines; everything new lives in Details, ⋯ or the popover. Motion respects
  `prefers-reduced-motion`; counters change colour briefly, never jump the layout.
- Keys never fire while typing in a field.

## Where the data comes from

| Shown | Source | New? |
|---|---|---|
| calls, failed, endpoints, first/last time, median ms, status strip | `GET /session-cycles/{id}/summary` in `backend-session-cycles` - counts from the captured calls, no bodies | **new endpoint** |
| ◆ SQL / ▤ log counts | db-capture counts per call id, summed in the same summary (through a port, the slice boundary kept) | new, in the summary |
| requirement verdicts, cards mentioning calls | `GET /board/cycles/{id}/verdicts?board=` (exists) | - |
| shared · N boards | `GET /board/cycles/{id}/boards` (exists) | - |
| description | `SessionCycle.description` (backend-session-cycles: column, PATCH with rename; in the cycle export/import and `get_cycle` for Claude) | **new field** |
| re-test name + its cards | `POST /board/boards/{id}/record` takes `cards`, `name`, `description`: names the cycle from the cards and relates each card to it (the card-cycle relation that exists) | **extended** |
| "Tests" vs "Found" | Tests = cards related to the cycle (`cardCycles`); Found = cards whose calls are in it (`verdicts.calls[].cards`) | - |
| a card's verdict in a re-test | the card's re-test checks on that cycle's calls (specs/016), else its requirement items' verdicts | - |
| re-test badge | the cycle has related cards and was made by Re-test (`kind` kept in the board's link, not on the cycle) | - |
| rename, assign, pause/resume | `SessionCyclesStateService` (exists) | - |
| delete plan, delete | `cycleDeletePlan` + `CycleDeleteService` (exists) | - |
| export | `CycleExportService` (exists, never truncates) | - |
| ask Claude | a board chat message from the user (`ChatStateService`) | - |
| add existing cycle / board | `relateCycle` / board relate (exist) | - |
| verdict timeline (1), ready to re-test (2) | card-cycle links + each re-test's card verdicts, ordered by cycle time; "fixed after" = the card's Fixed time vs its last re-test | - |
| steps (4) | description lines `- [ ]`, matched to calls by the requirement evidence matcher (`RequirementService`) | **new: steps check** |
| story (5), hot spots (7) | spacers + captured calls; `call_story` for why | summary endpoint |
| Claude's summary (9) | `SessionCycle.summary` written by the board session on pause (its own field, never the description) | **new field** |
| baseline (10), archived (12) | the board's link to the cycle (`baseline`, `archived` flags) - a board-side choice, not the cycle's | **new on the link** |
| environment (11) | the calls' upstream host, mapped by Settings' environments | - |
| evidence pack (13) | the existing .md/.html/.json builders, filtered to the cycle; Azure attach = `AttachmentWriter` bundle | - |

Compare is computed in the browser from two summaries and two verdict sets - no compare endpoint.

## Rules kept

- No polling: the list reloads on the `/ws/board` and session-cycle signals it already listens to; a recording cycle's
  counts follow the session-cycle "changed" signal.
- `related-strip` goes; the verdicts dialog (`CycleVerdictsDialogComponent`) and the existing export/delete services
  are reused, not copied.
- Phone width: cards stack, actions wrap, Details is one column.

## Steps

1. Backend: cycle `description` (column, API, export/import, MCP `get_cycle`); `record` with cards/name/description
   (naming rule in one place, tested); `CycleSummary` (domain), `GET /session-cycles/{id}/summary`, summary counts port for db-capture; tests.
2. Frontend: `board-cycles` rewritten as the list above (cycle card as its own component), compare dialog, add-existing
   dialog; `related-strip` removed from the page; specs.
3. Docs (docs/board.md "Cycles"), full test suites, Docker build, check in the browser.

## Built (2026-10-18) - and what differs from the prototype

- As planned: compact rows, Overview / Story / Calls / Requirements, re-tests named after their cards and linked to
  them, the description with self-ticking steps, Claude's summary apart (queued on pause while a runner answers the
  board; switch per board), ⚑ baseline and archive on the board's link, "vs baseline / previous", Compare, hot spots,
  the card verdict timeline, the ready-to-re-test line, the pause suggestion, Ask Claude, search / filters /
  environment / sort, selection, keyboard, live counters on the session-cycle signal.
- Not built yet, said here so nobody looks for them:
  - Evidence pack writes the existing cycle export (.md or .json, nothing cut); no .html and no Azure attach - attach
    a file from the Team tab's evidence bundle for now.
  - Compare has no "response shape changed" row (the summary carries no bodies) and no log-line counts; ◆ SQL counts
    are shown in Overview's facts.
  - Delete keeps the existing confirm (it says which mentioned calls are kept); Archive is its own menu item rather
    than an "Archive instead" button in that dialog.
  - Environment is the first host the calls went to ("env80"), not a Settings mapping.
