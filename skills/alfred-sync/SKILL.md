---
name: alfred-sync
description: Catch up with what the user did on the Alfred board - answers to Claude's questions, moves, flags, closes, edits, comments, accepted or dismissed proposals - and write one state comment per card saying what the user did and answered and what it means now, then act on it. Use after the user answered questions or changed cards, when they say "sync", "I answered", "check my answers", or "/alfred-sync".
argument-hint: "[project] [--dry]"
---

# Alfred sync

Read `rules.md` in this skill's folder first and follow it - this skill is the card journal's "when the user acted".

## 1. What changed

`board_changes` with cursor `claude` (everything after your last entry; `by: USER` for only the user's), for the
project (or every board). Group the entries per card.

## 2. Each card the user touched

`board_get` the card (every comment, the threads, `openQuestions`). Then write **one** state comment
(`board_comment`):

- **did** - what the user did and answered, in their words: "You answered Q1: No - filter the PCC list by branch.
  You moved it Inbox → To do. You flagged it Urgent. You set its teams to Backend + Frontend."
- **found** - what it means: the cause or the decision now ("a bug in the import page's PCC list, not config").
- **next** - the next step and who it waits on; pass `waitingOn`.

Then act within the rules:

- an answer turns a QUESTION into a bug and the card is still your Inbox card → `board_edit` its kind / description;
- the answer raises a new doubt → `board_ask` (once);
- the user replied to one of your comments → answer in its thread (`board_reply` with `replyTo`);
- a proposal accepted → note it; dismissed → state comment with what you will do instead;
- a card closed by the user → nothing more on it, except: closed as Fine / Not in this flow about a flow value → an
  `allowed` check line to propose (rules "Learning");
- an answer on a `Learn:` card (rules "Learning") → one check line per answer, to propose at the end; a "must" about
  something the question showed → open its BUG card now (`board_add` with the calls the question named); an answer
  confirming a good run → a `good run` line.

Never move cards to To do yourself because of an answer - that stays the user's move.

`--dry`: show the comments you would write and stop.

## 3. Finish

New check lines from the answers and closes: one before / after of the repo's `## Alfred checks` (rules "Project
checks"), saved only on yes.

Summary per card (one line each) and what now waits on whom. `board_session_log` on the cycle when the cards belong to
one. Next: `/alfred-fix` for To do cards, or what still waits on the user.
