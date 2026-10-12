---
name: alfred-triage
description: Sort an Alfred board's Inbox together with the user - one card at a time, a short summary and a recommendation (Fine, Not in this flow, To do, merge, ask) with the reason; the user decides, Claude records each decision on the card. Use when the user says "triage", "sort the inbox", "go through the findings", or "/alfred-triage".
argument-hint: "[project] [--dry]"
---

# Alfred triage

Read `rules.md` in this skill's folder first and follow it. Closing and scope are the user's: you recommend, the user
decides, and you never close a card yourself.

## 1. The Inbox

`board_search` with the project and `status: [INBOX]` (oldest first). `board_closed_reasons` to know what the user
dismissed before. Nothing in the Inbox → say so and give the next step (`/alfred-status`).

## 2. One card at a time

For each card: `board_get` and `board_evidence`. Show:

```
#11 BUG  read-pnr 409 for a PCC the import page offered
What: …one line…   Evidence: POST /read-pnr · 409, ImportBookedPnrService.java:121
Teams: Frontend + Backend - the page offers the PCC, the service refuses it
Recommend: To do - the page offers PCCs the branch cannot use (Acceptance 2).
```

Check the card's teams against the evidence (rules "Teams"); propose a change in the same line ("Teams: Backend →
Database - the INSERT fails") and apply it with `board_assign` when the user agrees or does not object.

Recommendations: **To do** (real, in scope), **Fine** (expected behaviour - say why), **Not in this flow**, **merge
into #n** (same problem), **ask first** (a decision is needed - name the question). Then wait for the user's choice
(they may answer for several cards at once: "11 todo, 12 fine, 14 merge 11").

## 3. Record the decision

- To do → `board_move` TO_DO (yours to do), state comment: what the user decided and why, `waitingOn` CLAUDE, next
  `/alfred-fix <n>`.
- Fine / Not in this flow / Won't fix → the user closes it (the card's buttons) - offer `board_propose` CLOSED with
  that resolution and the reason so it is one click; note it in the state comment. Fine about a flow value (a drift,
  a missing field) → note an `allowed` check line to propose at the end (rules "Learning").
- A `Learn:` card → not sorted like a finding: show its open questions; the user answers on the card (Answer
  button) or tells you here - then record them in one state comment ("You answered 1: ...") and note the check lines
  they give.
- Merge → `board_propose` MERGE into the card.
- Ask → `board_ask` the question, `waitingOn` USER.
- Teams the user changed or confirmed → `board_assign` (reason: "decided in triage") if not already set.

`--dry`: show the recommendations for every card and stop.

## 4. Finish

New check lines (allowed lines, `Learn:` answers): one before / after of the repo's `## Alfred checks`, saved only on
yes.

Summary: moved to To do, proposed closes waiting for Accept, questions asked. `board_session_log` on the cycle when the
cards belong to one. Next: answer questions on the board, then `/alfred-sync`; or `/alfred-fix`.
