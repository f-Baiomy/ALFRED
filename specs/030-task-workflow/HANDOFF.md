# Handoff - specs/030 task workflow (phases 1-4 done 2026-10-17)

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

### Done in the second session (2026-10-17)

| Task | What | Where |
|---|---|---|
| T008 | `check_calls`' cycle arg takes a board ref (its RECORDING cycle, else the newest) | `mcp-server/src/cycle-calls.ts` `findCycleOrBoard`, test in `board-ref.test.ts` |
| T013, T014 | `SyncResult` + `newItems` (`ArrivedItem`), `changedItems` (`ChangedItem`: fields, `newComments`), `mainState` (`MainState`: state, category, closed, iteration before/after), `matches`; old 6-arg constructor kept | `BoardItemsUseCase.java`, `BoardItemsService.sync` / `syncFull` / `mainMove` |
| T015 | `item_matches` table (+ board delete, connection delete) and port methods | `SqliteTeamCacheRepository.java`, `TeamCachePort.java`, `TeamModels.MatchRow/MatchState` |
| T016 | `MatchesUseCase` + `MatchService`: unlinked open cards x open Bug/Task/Issue of the tree, not linked, not made before the card (`System.CreatedDate` vs `CardInfo.createdAt`, new 10th component); score = shared words / smaller set + 0.5 per shared `/api/` path (numbers and `{x}` segments = `{id}`); >= 0.3 with 2+ words, or a path; top 5 per card; item text from the items the sync read live, else the copy, else the title; Claude's `why` survives re-scoring | `application/service/MatchService.java` |
| T017 | `GET /teamboards/cards/{card}/matches`, `POST .../{conn}/{item}/link` and `/reject` (user only), `PUT .../why` | `TeamCardsController.java` |
| T018 | `MatchServiceTest` (11). Only REJECTED rows travel in the board export, as `team-card-match` by card number (backend `TeamTransferService`, `ImportBoardService`; frontend `board-json.ts` + spec) | |
| T019 | MCP `team_card_matches` (list; `id` + `why` to judge; never links) | `mcp-server/src/tools/team.ts`, test in `team.test.ts` |

### Done after phase 1 (same day)

- Phase 2 (skills, `12d92c67`): rules §0 board refs and §0a (stages, item and child rules, refresh, matches); setup
  defines with cards and re-defines; triage's code look; verify's three-option question and Azure update; report's close
  bundle; team's card flows; guide's stages and 17 skills; board args everywhere. Backend: sync `wait`, Claude's
  asked link at once, new items under the main. MCP: refresh result, closest allowed state, listen runner `--board`.
- Phase 3 (frontend, `9a20cc5c`): `StageStripComponent` (stages, Define banner, Ask Claude in chat, Refresh from Azure,
  main-moved banner), the card's Azure panel in `card-items` (matches; direct comment/state; Draft with Claude).
- Phase 4 (docs + e2e): docs/team.md, board.md, mcp.md, CLAUDE.md; next-steps now count a board's home cards
  (`SqliteBoardRepository.nextSteps`) - the stage of AB#61813 read Test instead of Code before.

### Left

1. Done: the Azure half of the end-to-end on AB#61813 (T039, results in tasks.md). The board waits on the user's
   four Triage answers (#72-#75); after them `/alfred-fix 72` / `73` and `/alfred-verify AB#61813` can draft the Azure
   updates as bundles. A card match was not seen live (the Task items have no description) - only in `MatchServiceTest`.
2. Done since: the card's direct "Edit a field" (FIELD step, `ItemWriter.setField`, MCP `team_set_field`); the seed
   names an unreadable parent (`SeedBuilder.NOT_READABLE`).
3. Push the branch / open a PR when the user asks.

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
