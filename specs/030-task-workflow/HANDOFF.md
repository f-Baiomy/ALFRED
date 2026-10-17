# Handoff - specs/030 task workflow (stopped 2026-10-17)

Read this first, then [spec.md](spec.md) (the 28 agreed decisions are under Clarifications), [plan.md](plan.md) (design
D1-D10) and [tasks.md](tasks.md) (each task with [X] done / [~] partly / [ ] open). The mock is
[mock-workflow.html](mock-workflow.html).

## Where it stands

- Branch `030-task-workflow` (made from `028-team-live-search`, which holds 3 earlier unpushed commits). Nothing pushed.
- Commits on this branch: `889ca54a` (spec, plan, tasks, mock), `44359fd8` (phase 1 part: seed, board refs, stage).
- Working tree clean after the handoff commit.

### Done and tested (targeted tests only)

| Task | What | Where |
|---|---|---|
| T001-T004 | Seed: every child in full (`childItems`: fields by the field maps, comments, `done`, grandchildren lines), parents up to the top, the item's comments. Old `children` lines kept | `teamboards-core/.../port/in/SeedUseCase.java`, `.../service/SeedBuilder.java`, test `TeamServicesTest.theSeedReadsEveryChildInFullAndTheParentsUpToTheTop` (34/34 pass) |
| T005 | `team_item` seed parts `children`, `parents`, `comments` (paged, never cut) + `counts` | `mcp-server/src/tools/team.ts`, test in `mcp-server/test/team.test.ts` |
| T006 | Not needed: `GET /board/boards` already gives each board's main as `linkedItem` (`conn/id`) | - |
| T007, T009 | Board refs: `AB#id`, `conn/id`, item URL, name, name prefix, id; bare `#n` refused as a card number | `mcp-server/src/board-ref.ts`, `mcp-server/test/board-ref.test.ts` |
| T008 [~] | Refs used by `task_context` (a cycle on a board loads the board), the `board` param of every task tool (`board-scope.ts`), `board_record/home/relate/move_home/cycle_verdicts` (`tools/boards.ts`). **Open:** `check_calls`' cycle arg given a board | as left |
| T010-T012 | `BoardStage` (DEFINE/TRIAGE/CODE/VERIFY/TEST/CLOSE + next command), `BoardStageService`, `GET /board/boards/{id}/stage`; task_context prints `STAGE:` and uses its `next` | `backend-board/.../domain/model/BoardStage.java`, `.../service/BoardStageService.java`, `.../web/BoardStageController.java`, `BoardStageTest` (2/2), `mcp-server/src/tools/task.ts` |

### Next, in order

1. **T013** - extend `SyncResult` (`BoardItemsUseCase.java:48`) and `BoardItemsService.sync` (~line 364) with: `newItems`
   (the `arrived` list), `changedItems` (ids whose `syncFull` returned true), `mainState` (the main's state/iteration
   before vs after: read its copy before `syncFull`, compare after; category via `live.category`), `matches` (count from
   T016). Keep a constructor with the old 6 args. Endpoint already exists: `POST /teamboards/boards/{board}/sync`.
2. **T015** - `item_matches` table in `SqliteTeamCacheRepository.java` (DDL list near the `incoming` table, line ~195;
   follow the `incoming` put/list methods at ~799-835) + methods on `TeamCachePort`. Row: board_id, card_id, conn, item,
   state (PROPOSED/LINKED/REJECTED), why, score, at; PK (card_id, conn, item).
3. **T016** - `MatchService` in core: unlinked cards = `TeamBoardsPort.cardsOfBoard(boardId, n)` minus those with
   `cache.cardLinksOfBoard`; candidates = `cache.boardItems(boardId)` rows of type Bug/Task/Issue, not closed
   (`Live.closed(category)`), with no card link; score = shared words (title+description, stop words out, len >= 3) and
   `/api/...` paths in the card text found in the item text (item text from `cache.copy` when held, else its title, or
   from the live items the sync already read). Never re-propose a REJECTED or LINKED row. Call it at the end of `sync`.
4. **T017** - endpoints in `TeamCardsController.java`: `GET /teamboards/cards/{card}/matches`,
   `POST .../matches/{conn}/{item}/link` (link through `CardItemsUseCase.link(Who.USER, card, conn, item, Markers.NONE, null)`
   = no bundle; then LINKED and drop the item from other cards' proposals), `POST .../reject`, `PUT .../why` (Claude).
5. **T018, T019** - `MatchServiceTest` (use `TeamFixture`, real SQLite in a temp dir); MCP `team_card_matches` in
   `tools/team.ts` + test; add it to the matches export if the board export lists `card_links`.
6. **T020** - full suites + `docker compose build backend`, commit. Then Phase 2 (skills, T021-T031), Phase 3 (frontend,
   T032-T037), Phase 4 (docs + end to end on AB#61813, T038-T040).

## How to run things here

- Backend tests (JDK 21 in Docker; bare `mvn` here is JDK 8), from the repo root in Git Bash:
  `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/repo" -v alfred-m2:/root/.m2 -w //repo/backend maven:3.9-eclipse-temurin-21 mvn -B -q -pl backend-teamboards/teamboards-core -am test -Dtest=TeamServicesTest -Dsurefire.failIfNoSpecifiedTests=false`
  then read `target/surefire-reports/TEST-*.xml` (`-q` prints nothing on success).
- MCP: `cd mcp-server && npx tsc --noEmit -p . && npx tsx --test test/<file>.test.ts`.
- Skills after Phase 2: `pytest tests/python/test_alfred_skill.py`, then `python alfred_skill.py install`.

## Gotchas met in this session

- Python run from a Bash heredoc lost backslashes (`'\n'` became a real newline, `\'` became `'`), which broke TS
  strings. For edits that carry escapes, use the Edit tool, or a script file written with the Write tool.
- Several MCP files are CRLF: a Python `str.replace` with `\n` silently misses; match `\r\n` or use the Edit tool.
- Agreed rules to keep: only the user opens a board (`askedIn`); nothing goes to Azure without a bundle the user
  approves, except the user's own direct write; Claude never holds the token; no polling; reuse components; at most one
  subagent; mock and plan first; commits end with the Co-Authored-By line; `docker compose build backend` before calling
  backend work done.
