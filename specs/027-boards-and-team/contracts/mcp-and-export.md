# Contract: MCP tools and export records

## MCP tools (`mcp-server/src/tools/`)

Every board tool gains an optional `board`:

- When it is missing and `cycleId` is given, the tool uses the board with that id, else the only board related to the cycle, else it errors with the choices.
- When both are missing, the tool uses `default:<project>`.

| Tool | New/changed | Notes |
|---|---|---|
| `board_boards` | new | list boards (project, state, q) |
| `board_open` | new | create a board; **only when the user asked**; requires `askedIn` (chat message id or `"terminal"`) |
| `board_relate` | new | relate/unrelate a cycle or a board |
| `board_move_home` | new | move a card's home |
| `board_record` | new | start a recording for a board; returns `RUNNING` with options when one records |
| `check_calls`, `wait_for_calls` | changed | one run per cycle; result names the related boards; finding homes follow research R5 |
| `board_add`, `board_add_many` | changed | `board` param; home by R5 when omitted on a shared cycle (asks when several) |
| `task_context` | changed | takes `board` (or `cycleId` resolved as above) |
| `create_cycle` | changed | optional `board` to relate on create |
| `team_items` | new | read cached work items (filters) |
| `team_item` | new | one item with mapped seed (`purpose`, `steps`, `acceptance`, `context`, links, attachments) |
| `team_changes`, `team_squads` | new | read cache |
| `team_link` | new | link a board to an item (used by `/alfred-setup`) |
| `team_start` | new | same as the Start button; only when the user asked |

Skills updated together (test `tests/python/test_alfred_skill.py`): alfred-setup (accepts `AB#id` / `<conn>/<id>`, creates the board and first cycle), alfred-live (`/alfred-live <board>`), alfred-listen (per cycle, homes per R5), alfred-review, alfred-resume, alfred-status, alfred-report, alfred-verify, alfred-guide, and the shared `rules.md`.

## Board export records (`board-json.ts` ↔ `ImportBoardService`)

New record types, one per line, written before the cards:

```json
{"type":"board","id":"…","project":"odeysys","name":"Refund by voucher","isDefault":false,"state":"OPEN","migratedFrom":"rec 14 Oct"}
{"type":"board-cycle","boardId":"…","cycleId":"…","cycleName":"rec 14 Oct"}
{"type":"board-board","a":"…","b":"…"}
{"type":"workitem-snapshot","boardId":"…","conn":"az1","extId":"4521","url":"…","title":"…","state":"Active","type":"Bug","assignee":"…","squad":"…","sprint":"…"}
```

- Cards carry `boardId` and `relatedCycles`.
- An import without `board` records puts every card on `default:<project>`.
- Older Alfreds skip unknown `type`s: checked once by importing a new export into the previous release (quickstart step), and a unit test asserts the importer skips an unknown `type`.
- No enum gains a value.
