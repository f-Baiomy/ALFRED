# Tasks: Task workflow (specs/030)

**Input**: [spec.md](spec.md), [plan.md](plan.md), [mock-workflow.html](mock-workflow.html)
**Order**: Backend + MCP → Skills → Frontend → Docs + end to end. One commit per phase; full suites at the end of each.
**[P]** = can run beside the other [P] tasks of its phase (different files). Story labels map to spec.md's user stories.

## Status (2026-10-17, stopped by the user) - see [HANDOFF.md](HANDOFF.md)

- Done and tested: seed children/parents/comments (backend + `team_item` parts), board refs (`src/board-ref.ts`), board stage
  (`BoardStage`, `GET /board/boards/{id}/stage`, task_context STAGE/NEXT).
- Phase 1 done (T001-T019): also the refresh result (`newItems`, `changedItems` with new comments, `mainState`, `matches`),
  card matches (`item_matches`, `MatchService`, `/teamboards/cards/{card}/matches...`, `team_card_matches`), rejected
  matches in the board export (`team-card-match`), and `check_calls` taking a board.
- Next: Phase 2 (skills, T021-T031).

## Phase 1: Backend + MCP

### Seed (US1, FR-003)

- [X] T001 [US1] Add `SeedChild` and `SeedParent` records and `children`/`parents`/`childrenLines` to the `Seed` record in `backend/backend-teamboards/teamboards-core/src/main/java/com/fathy/alfred/backend/teamboards/core/application/port/in/SeedUseCase.java`
- [X] T002 [US1] In `SeedBuilder.java`, build each child through `maps(conn, type)` + `SeedContributor` (purpose, steps, acceptance, context), with state, assignedTo, `closed` from `item_states` category, and its comments
- [X] T003 [US1] In `SeedBuilder.java`, walk `Parent` links to the top (cap 6, loop guard; copy first, else live) into `parents`; grandchildren as title lines from each child's `Child` links in one `live.items` batch
- [X] T004 [US1] Tests in `TeamServicesTest.java` + `TeamFixture.java`: story with Epic/Feature parents and one child of each type (Bug with repro, Task closed, Investigation, Meeting, Test Case); every child's fields present, closed flagged, parents chained, grandchildren titles, nothing cut
- [X] T005 [US1] `mcp-server/src/tools/team.ts`: seed parts `children` and `parents` in `SEED_PARTS`, paged with `part` + `offset`; head shows counts; test in `mcp-server/test/team.test.ts`

### Board refs (US2, FR-009)

- [X] T006 (not needed: GET /board/boards already gives each board's main as linkedItem; AB# resolves from it) [US2] `GET /teamboards/items/{conn}/{id}/boards` (role per board) in `TeamStartController.java` via `cache.boardsOfItem`; controller test
- [X] T007 [US2] New `mcp-server/src/board-ref.ts` `resolveTask(client, arg)`: board id → `AB#<id>` / `<conn>/<id>` / URL → name exact → name prefix → cycle id/name; bare `#n` refused; candidates on ambiguity
- [X] T008 (task_context, the board param of every task tool, board_record/home/relate/move_home/cycle_verdicts, check_calls' cycle arg via `findCycleOrBoard`) [US2] Use `resolveTask` in `task_context` (`mcp-server/src/tools/task.ts`) and in `board_record`, `board_home`, `board_cycle_verdicts` (`tools/boards.ts`), `get_brief`, `read_spec`, `board_requirements`, `board_steps`, and `check_calls`' cycle arg (board → recording or latest cycle)
- [X] T009 [US2] Tests `mcp-server/test/board-ref.test.ts`: each form, `#60` refused, `AB#` with no board, task_context with board id 261e0010-shaped id

### Stage (US8, FR-013)

- [X] T010 [US8] `backend/backend-board/.../application/service/BoardStage.java` (DEFINE, TRIAGE, CODE, VERIFY, TEST, CLOSE with next command and `<ref>`), port + `GET /board/boards/{id}/stage` in `BoardInsightsController.java`
- [X] T011 [US8] `BoardStageTest.java`: one board per stage, and the order when several hold
- [X] T012 [US8] `nextStep` in `mcp-server/src/tools/task.ts` reads the stage endpoint, falls back to its own order; test

### Refresh (US5, FR-014, FR-017)

- [X] T013 (comments as `changedItems[].newComments`) [US5] Extend the `/teamboards/boards/{board}/sync` result with `newItems`, `comments`, `mainState` (category, iteration move) in `TeamService.java` / `BoardItemsUseCase.java`; new items still go to Incoming
- [X] T014 [US5] Tests: new child after the copy, new comment, main moved to Removed, main moved out of its iteration

### Matches (US6, FR-015)

- [X] T015 [US6] `item_matches` table in `SqliteTeamCacheRepository.java` + port methods in `TeamCachePort`
- [X] T016 [US6] `MatchService.java` (core): candidates for unlinked cards (open Bug/Task in the main's tree, created after the card, word overlap, endpoint paths from mentions/text), threshold, REJECTED never re-proposed; called from sync (T013) and on demand
- [X] T017 [US6] Endpoints in `TeamCardsController.java`: `GET /teamboards/cards/{card}/matches`, `POST …/matches/{conn}/{item}/link` (card_links + LINKED + drop from other cards), `POST …/reject`, `PUT …/why` (Claude)
- [X] T018 (only REJECTED rows travel, as `team-card-match` by card number) [US6] `MatchServiceTest.java`: score, created-before excluded, reject kept, link clears other cards; matches in the board export/import
- [X] T019 [US6] MCP `team_card_matches` (list, `why`) in `mcp-server/src/tools/team.ts` + test

### Phase 1 close

- [ ] T020 Full backend suite (Docker JDK 21), MCP suite; `docker compose build backend`; commit "feat(team): seed children and parents in full, board refs, board stage, refresh result, card matches (specs/030)"

## Phase 2: Skills

- [ ] T021 [US1] `skills/_shared/rules.md`: board refs; item-type rules (Epic, Feature/Story, Task, Bug, words); child-type rules (Bug → BUG card with reproduce scenario, Task → TASK card, Investigation/Spike → decisions + data, Meeting → decisions, Test Case → test step, other → context); "Azure says done"; uncovered AC → TASK card; source on every drafted line; the seven stages; matches
- [ ] T022 [US1] `skills/alfred-setup/SKILL.md`: args; fill an existing board; read `children` + `parents`; draft with cards; one Save all → `board_set_brief`, `board_put_spec`, `board_evidence_put`, `board_add_many`, `team_link_card` (askedIn, no markers); Epic sections + Feature board offers
- [ ] T023 [US5] `alfred-setup` re-define: before → after per part; removals one at a time (`board_ask` per removal when started from the board chat, conversation questions in the terminal); new cards after `board_similar`; closes via `board_propose`; refresh: read the sync result, judge matches (`team_card_matches` why), propose; main closed → proposals
- [ ] T024 [P] [US3] `skills/alfred-triage/SKILL.md`: planned cards - where the change goes, owning team, already written (file:line, commit); "Record as fixed?" among the options
- [ ] T025 [P] [US4] `skills/alfred-verify/SKILL.md`: board args; three-option "Record as fixed?"; bundle = comment (commit, branch) + state Resolved/Closed or closest, said so; read the stage
- [ ] T026 [P] [US2] `skills/alfred-listen/SKILL.md` + `alfred-listen.mjs`: board args; recording cycle or "press Record on the Cycles tab" and wait
- [ ] T027 [P] [US2] `alfred-live`, `alfred-review`, `alfred-spec`, `alfred-status`, `alfred-resume`: board args; spec points to rules for the shape
- [ ] T028 [P] [US8] `skills/alfred-report/SKILL.md`: close bundle for the main item when every card is Verified/closed
- [ ] T029 [P] [US6] `skills/alfred-team/SKILL.md`: "update card #n" (Draft with Claude) → bundle; matches; create in Azure
- [ ] T030 [P] `skills/alfred-guide/SKILL.md`: seven stages, all 17 skills, board-page paths, Start vs New board, setup vs spec
- [ ] T031 Runner tests (`mcp-server/test/live-runner.test.ts`) for board args; `pytest tests/python/test_alfred_skill.py`; `python alfred_skill.py install`; commit "feat(skills): one task workflow - define with cards, triage, verify, listen, close (specs/030)"

## Phase 3: Frontend

- [ ] T032 [US8] `core/team` + `core/board` API/models: stage, sync result fields, matches endpoints, item boards
- [ ] T033 [US8] `components/board/next-steps-bar`: seven-stage strip from the stage endpoint, current marked, command + Copy; spec
- [ ] T034 [US1] "Not defined yet" banner in the strip at DEFINE: command + Copy, "Ask Claude in chat" (posts `/alfred-setup <ref>` to the board chat) enabled only when a live runner / terminal answers the board; spec
- [ ] T035 [US5] `pages/board/board-page`: "↻ Refresh from Azure" (board with a main) → sync; result line; main-closed banner; re-read on `/ws/board`; spec
- [ ] T036 [US6] [US7] `components/team/card-items`: linked → Azure ▾ (Comment / State / Field direct, Draft with Claude); unlinked → matches (Link / Not this one / Show others) then Create in Azure; spec
- [ ] T037 Frontend suite + `npm run build`; prod Docker frontend build; commit "feat(board): stage strip, Define banner, Refresh from Azure, card Azure panel with matches (specs/030)"

## Phase 4: Docs + end to end

- [ ] T038 [P] `docs/team.md`, `docs/board.md`, `docs/mcp.md`, `CLAUDE.md` line
- [ ] T039 End to end on AB#61813 in Docker: New board (silent) → `/alfred-setup AB#61813` draft → Save all → `/alfred-triage` → `/alfred-verify` → Record + `/alfred-listen` → Refresh → one card match; every bundle left waiting; screenshots
- [ ] T040 All suites once more; commit "docs: task workflow (specs/030)"

## Dependencies

- T001 → T002 → T003 → T004; T005 after T003.
- T006 → T007 → T008 → T009.
- T010 → T011, T012.
- T015 → T016 → T017 → T018, T019; T013 needs T016 for `matches`.
- Phase 2 needs Phase 1 (the skills name `team_card_matches`, the seed parts, board refs).
- Phase 3 needs T010, T013, T017.
