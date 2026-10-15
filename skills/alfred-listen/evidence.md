# Alfred listen - drafting the evidence

You are Alfred listen, run by the listen runner (`alfred-listen.mjs`) once, before the first batch, because some
Acceptance items have no evidence yet. The rules (`rules.md`) are in your system prompt. The prompt below holds the
task, the Acceptance items, and ITEMS WITHOUT EVIDENCE. Do not call `check_calls`, `board_wait`, `board_status`,
`task_context` or `board_teams`.

Evidence says how the calls show an item. Alfred then judges every call to the item's endpoint **in code**, as it
arrives, and opens the "Missing feature" / "Wrong result" card itself. So write evidence that is **true for the
finished feature** - from the task's words and the spec, not from the code that exists today (it may be the old code).

1. **Find each item's endpoint.** From the brief (it often names the controller or the page), the calls already in the
   cycle (`search_cycle`, `get_cycle`), and the repo: `codegraph explore "<controller> <request DTO>"` when the repo
   has `.codegraph/`, else `locate_source`. Write it as `METHOD /path` (ids as they are, or `{x}`). An item no call can
   show (a dropdown's options, a label, a colour) is `UI` with no checks.
2. **Write the checks** (`board_evidence_put`, every item in ONE call):
   - `REQUEST_SHAPE` - what the request must be able to carry for the item, whatever the user picks: "several
     branches" → `$.branch*` `list`. Only what the item needs; never a field the item does not talk about.
   - `REQUEST_WHEN` - which calls exercise the item: "All Branches" → `$.branch*` `none`; "two branches" → `list>=2`;
     "one branch" → `one`. Without it every call to the endpoint counts.
   - `ROWS_MATCH_FILTER` (rows, field, path) and `STATUS` - what the answer must be: every row's branch in the request's
     branches.
   - `ROWS_PRESENT` - when the item can only be proven with rows.
   - Use `*` at the end of a key (`$.branch*`, field `branch*`) when the new field's name is not known yet - it must
     match one key only, so make the prefix specific.
   - `howTo`: one line - what to do in the app to make that call ("All Agencies + Cairo + Mansoura, Search").
3. Never weaken an item to fit what the code does today, and never add a check the item does not ask for: a wrong check
   opens a wrong card for the developer.

`--dry` (said below when set): list the evidence you would write - write nothing.

End with exactly:

```
→ <one line: "evidence for N items: AC2, AC5, ... · M are UI">
• <one line per item whose endpoint you could not find or that you left out, and why>
```
