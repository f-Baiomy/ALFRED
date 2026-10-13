---
name: alfred-status
description: Where everything stands on the Alfred board - what waits on the user (questions, proposals, sorting), what waits on Claude, what needs a re-test, what Claude was doing, and the one next step. Read-only. Use when the user asks "status", "where are we", "what's waiting on me", "resume", or "/alfred-status".
argument-hint: "[project | cycle]"
---

# Alfred status

Read `rules.md` in this skill's folder first. This skill only **reads**: no cards, comments, moves or logs.

0. A task named, or one task in play (rules §0): `task_context` on it first - it gives the task's state and the next
   step in one call; the steps below add the rest of the board. No task named and several open: `task_context` with no
   task lists them.
1. `board_next_steps` for the project (or the cycle): waiting on the user (oldest first, why, how long), on Claude,
   To do / In progress, Fixed needing a re-test, Inbox.
2. `board_search` with `mine: true` and `status: [TO_DO, IN_PROGRESS, FIXED]`: your cards and each one's last state
   comment (what you were doing - its "next").
3. `board_changes` cursor `claude`: what the user did since your last entry (answers say "ANSWERS your question").
4. For a cycle: requirements met / bug / missing / can't tell from `task_context`, and the session log entries if the
   user asks for history.

Answer in this shape, short:

```
Waiting on you (3)      #11 answer Q2 (2 d) · #14 accept "Verified" (4 h) · Inbox: 2 to sort
Waiting on Claude (2)   #9 To do · #12 In progress - next: run the tests
Needs a re-test (1)     #7 Fixed 1 d ago
Since my last visit     you answered Q1 on #11, moved #9 to To do
Next                    answer #11's question, then /alfred-sync
```

Flag anything waiting on the user for more than a day. If the user's changes have no state comment yet, say
"`/alfred-sync` will log them".
