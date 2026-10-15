# 018 - Impact investigation (before implementing)

Date: 2026-10-14. Read from the code, not assumed. Each finding: what the code does today, what the plan would have
changed, the risk, and the design change it led to (already applied to plan.md, section "Revisions after impact").

## 1. Faster batch edges would make false cards - REVISED

- Today: a batch closes after 3 s quiet (`listenWait` → `waitForCalls` quietMs). A call's ERROR/WARN lines and SQL arrive
  after it completes - the agent sends them in batches; `RetestService` re-signals after `LATE_SIGNAL_SECONDS` = 20 s
  for exactly this reason, and `check.ts` rechecks a call for `RECHECK_SETTLE_MS` = 30 s.
- Plan had: close a batch after 250 ms gap / at an evidence call.
- Risk: flagged calls judged before their log lines arrive. Rules §4 says "a failure with no log line at all also gets a
  TASK flagged AFFECTS_PROJECT: Logging gap" - judged 250 ms after a 500, that card is false. Each late line also
  re-judges the call (`rechecked`) - a second model run for the same call.
- Revision: **the wait stays as it is** (3 s quiet, the late-line rechecks unchanged). Automatic edges become **split
  points inside a batch**: the batch text shows `── action 2 (0.9 s pause) ──` / `── area: Users ──` between calls, so
  the judge sees one action per section, for people and automation alike. No timing change, no new runs.
- Speed: requirement verdicts do not wait for any batch at all - they run in the backend on each call's completion (§3),
  so "judged at once" holds where it matters without shortening the wait.

## 2. Request shape in `groupKey` would split groups - REVISED

- Today: `groupKey` (check.ts) = endpoint, status, signals, supplier outcome, DB flags, soft failure, empty keys, first
  ERROR/WARN, failed statement, diff keys, slow, nomark, hung. The runner ledgers by `key`; `splitKnown` auto-handles a
  known key (`fine | recurs` → no run).
- Plan had: add the request shape to the key.
- Risk: a frontend that omits optional fields (`pnr` sent only when typed) gives one endpoint several shapes → one bug
  split into several groups → more runs, and duplicate cards when two parallel runs judge them.
  Also every ledger key changes on upgrade (all groups judged once more).
- Revision: **`groupKey` unchanged.** Each group gets a separate `shape` (hash of field names + list/object/value, null
  matches anything) in the JSON. The runner stores the shape with a `fine` ledger entry; a known group whose shape is
  new is judged again (once). Grouping, keys, ledger and existing tests are untouched.
- The body: today the request body is read only by `indexCalls` (hop diffs, skipped with `hopDiffs: false`, delayed up
  to `WRITES_SETTLE_MS` = 10 s while writes settle). The shape is taken in the same `sidesOf` read and kept in the
  cycle memory (a few bytes per call, kept when the index is dropped); a call not indexed yet has `shape: null` and is
  never treated as "new shape". No extra request.

## 3. Verdicts in the backend - the watch only signals today

- Today: `BoardRetestWatchAdapter.onCallCompleted` → `RetestService.callArrived` → on the one `board-retest-watch`
  thread, lists the FIXED/VERIFIED/DONE cards of the project and signals the matching ones (a chip refresh), again after
  20 s. The check itself runs on read (`board_verify`, the drawer).
- New work: evaluating an item and possibly **writing a card** on arrival - something no board code does without an
  actor today.
- Cost: per inbound call, one in-memory lookup "does an item's evidence name this project + endpoint" (cache, cleared on
  evidence write). Only on a match: read the call's request/response at the named paths (`CallFactsPort`, extended) -
  one call, paths only. Non-matching calls cost a map lookup.
- Cycle membership race: the call may not be in the cycle yet when the observer fires (the session-cycles capture is
  another observer). Use the existing 20 s re-signal; an item is judged from the cycle's calls, never from the one call
  object, so a call missed on the first signal is caught on the second.
- Thread: its own single-thread executor (not the re-test watcher, so a body read never delays re-test chips) - bounded,
  in arrival order, never on the webhook's thread (a call's completion is never slowed).

## 4. New enum values break older readers - REVISED

- `Flag` is parsed with `Flag::valueOf` (SqliteBoardRepository:1291) - an unknown value throws, and the card list fails.
  A board exported from this version and imported into an older Alfred (two Alfreds on a LAN, a downgrade) would break
  every list holding such a card. 15 files know the flag set (frontend, mcp-server zod, quick-add parsers).
- `Actor` (USER, CLAUDE) has 21 `valueOf` uses: adding an "ALFRED" actor has the same problem.
- `Expectation.Kind` is read from `retest_plans.plan_json` with Jackson inside a try - an unknown kind gives an empty
  plan, not a crash. Item evidence goes in a new table older versions never read.
- Revision: **no new `Flag`, no new `Actor`.** A missing-feature card is a TASK, author CLAUDE, linked to its item
  (`board_link_spec`) with title `Missing feature: …` and a first comment saying it was opened by Alfred's requirement
  check (call, field, value). The Task tab shows "Missing" from the item's verdict, not from a flag. The three new
  expectation kinds are allowed only in item evidence (card plans keep the five), so the card re-test editor and an
  older Alfred never meet them.

## 5. Spacers today

- Listen asks the user for spacers (`alfred-listen/SKILL.md:41` "Steps need spacers. Ask once…"); `batch.md:44`,
  `finish-steps.md:10`, `alfred-review/SKILL.md:21`, `rules.md:195` match steps by spacers; the runner sends a SPACERS
  block (`alfred-listen.mjs:361`).
- Change: all five stop depending on them (the ask is removed). Steps tick from their items' calls, then from the
  automatic action / area sections (§1). `suggest_spacers` keeps working as a tool; nothing writes spacers.
- Risk: a user who did add spacers loses them as the step grouping. Accepted (the owner's decision: no human input).

## 6. Unchanged (checked)

- Hop diffs and flows (`flow-diff.ts`): the index is cross-batch; nothing in it changes.
- Re-tests of cards, guards, regressions: same code path; item evidence is a separate table and service.
- Recheck / sweep: `markSignature` lists its fields explicitly; the new `shape` is not in it, so no call is re-judged
  because of the upgrade.
- `wait_for_calls` (tools/watch.ts:281) is a separate caller of `waitForCalls`; untouched.
- Gateway / `SpaPageFilter`: new routes sit under `/board` - no prefix change.
- Exports (.md/.html/.json): cards export as today; no new card field.

## 7. Tests that will change, and why

| Suite | Change |
|---|---|
| `mcp-server/test/check.test.ts` | adds `shape` per group; grouping assertions unchanged |
| `mcp-server/test/listen-runner.test.ts` | new: shape-change re-judges a `fine | recurs` group; action sections in the batch text; `--now` session log; 0-commit TASK once; spacers absent from the pack |
| `RetestServiceTest` | unchanged (card plans keep five kinds) |
| new `RequirementServiceTest`, `ItemEvidenceTest` | verdicts, one card per failing capability, closed-as-Fine respected, re-signal race, unique-match rule |
| `acceptance-checklist` spec | verdict pills and counts |
| `test_alfred_skill.py` | new tool names in the skills |

Everything else must pass unchanged: ArchUnit, the no-truncation guards, `SpaPageFilterTest`, `snippet-security.spec.ts`.
