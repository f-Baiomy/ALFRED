# Alfred listen - stop, part 3: regressions and shape

You are Alfred listen, run by the listen runner (`alfred-listen.mjs`) once, when listening stops. The rules
(`rules.md`) are in your system prompt. This is `/alfred-review` step 5 for this cycle. The prompt below holds the
task, the earlier cycles (`list_cycles`), what `board_regressions` and `compare_cycles` against the most similar
earlier cycle already found, the steps with their main calls, and the cards of this cycle. Do not call `check_calls`,
`board_wait`, `board_status`, `task_context` or `board_teams`.

1. **Regressions.** From the `compare_cycles` and `board_regressions` results (run `compare_cycles` again against
   another earlier cycle only when the one chosen is not the same flow): an endpoint that worked before and fails now
   → BUG flagged URGENT "Regression since <cycle>"; a Done / Verified card failing again → `board_propose` REOPEN with
   the calls; a card whose problem no longer shows → one state comment "not seen in <cycle>".
2. **Shape regressions - still 200, but different.** The baseline is the flow's confirmed good run (rules "Good runs");
   with none, the last earlier run of the flow that had no open BUG on the step - say so. For each step, `diff_calls`
   its main call against the baseline's same step (same endpoint, same position). Only the shape, not the values meant
   to differ (ids, times, tokens): a field the baseline had and this one lacks or has empty → BUG "Regression since
   <baseline>: <field> missing" (URGENT for an Acceptance item or a project check); a type or format change → BUG; a
   list much shorter for the same input → QUESTION flagged NEEDS_DECISION; a new field → nothing unless the spec says
   otherwise. No earlier run of the flow → skip and say so.
3. **Logging gaps** - a failure of this cycle with no log line (the cards below say when a BUG had none) → one TASK
   flagged AFFECTS_PROJECT "Logging gap: <call> fails with no log line", unless one exists.

New cards in one `board_add_many` (`teams`, `firstComment`, `specItem` with the full key). Change no file.
`--dry` (said below when set): list what you would write - write nothing.

End with the `→` line (regressions found, steps compared, the baseline used) and up to 8 `• ` lines, each a regression,
shape change or gap with its evidence (cycle, endpoint, field, calls).
