# specs/021 - Readable references: build plan

Rule: reuse the existing mention chip, call popup, spec viewer and drawer - extend them, never write parallel ones.
Form chosen: meaning first, code in parentheses - `one-branch search (AC8)`. Short names: stored per Acceptance item and
per card. Old cards: not rewritten; bare codes are drawn as chips on display (the user did not pick the rewrite).

## Reference kinds and the existing mention type each becomes

| Claude writes | Mention | Ref | Opens |
|---|---|---|---|
| AC8 | spec | `<cycleId>/<file>#ac8` | spec viewer at the item + verdict, its calls, marks (new strip) |
| #47 (a card) | card | `<project>#47` | card drawer |
| call id | call | `in:<id>[@<cycle>]` | call popup (Live Calls card) |
| calls #75 (cycle numbering) | call | `in:<id>@<cycle>` | call popup |
| SQL n of a call | stmt | `<callId>/<seq>` | call popup opened at the DB panel, statement highlighted (new) |
| log line | log | `<callId>/<lineId>` | call popup at the Logs panel (new) |
| Redis command | redis | `<callId>/<seq>` | call popup at the Redis panel (new) |
| [6] history index | card | `<project>#49@<entryId>` | drawer scrolled to that entry (new) |
| step 5 | plain words (Claude writes the step text) | - | - |
| NO_DATA, REQUEST_WHEN, batch, run id, app start | plain words | - | - |

## Pieces

1. Backend `backend-board`: `short_names` table; `shortName` on card summaries and requirements; `PUT /board/cards/{id}/short-name`,
   `PUT /board/cycles/{id}/requirements/short-name`. Claude may set one only where none is set.
2. Frontend chip: live label (card short name / title, item short name, status), state dot, meaning-first form;
   bare codes (`AC8`, `#47`, `calls #75`, `[6]`, a full call UUID) in old text drawn as chips; group chip for 3+ calls in a row.
3. Frontend popups: call popup `part` + `seq` focus; spec viewer `#acN` + item strip; drawer entry focus.
4. Mention picker: `@AC8`, `@#47`, `@call 75` complete to the chip.
5. MCP `readable.ts`: every board write converts bare codes to mentions with their meaning; the reply says what was
   converted and what was not found. `board_short_name` tool; `shortName` on board_add.
6. Skills `rules.md` "Readable references"; docs board.md, mcp.md.
