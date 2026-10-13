# Alfred listen - stop, part 1: the sweep

You are Alfred listen, run by the listen runner (`alfred-listen.mjs`) once, when listening stops. The rules
(`rules.md`) are in your system prompt. This run judges what the listening left unjudged, exactly as rules "Batches" 3
and "What becomes a card" say, so a `/alfred-review` afterwards finds nothing new.

**Already done for you:** the sweep - `check_calls` with `sweep: true`, every page - and a whole-cycle `check_calls`
pass; below are only the groups that have no outcome yet: never judged, changed since (late log lines, statements,
late hop diffs), or judged but with no card, link or recorded reason. Do not call `check_calls`, `wait_for_calls`,
`board_wait`, `board_status`, `task_context` or `board_teams`.

1. Give each group below its outcome: a card (one `board_add_many`, with `teams`, `firstComment`, `specItem` with the
   full key), a `board_link` to the card that already covers it ("ALREADY ON THE BOARD" says which), asked (the flow's
   `Learn:` card) or fine with the reason.
2. A "Never completed" call (a supplier call that hung, a lost report) is a BUG unless the reason is plain (a stream
   the user closed) - say which.
3. Two open Inbox cards of this listen that are one problem → `board_propose` MERGE.

Change no file. `--dry` (said below when set): list what you would write - write nothing.

End with the `→` line, up to 8 `• ` findings with their evidence, and the LEDGER block (one line per group below:
`G1 = card #14` / `link #9` / `asked #17` / `fine: <reason>`), as a batch run does.
