# Tasks: Team trackers live, linked to Alfred boards and cards

**Input**: `specs/028-team-live-search/` (spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md, mock.html)
**Tests**: included (constitution VI).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1…US9 from spec.md

## Path Conventions

- `BOARD` = `backend/backend-board/src/main/java/com/fathy/alfred/backend/board`, `BOARD_T` its tests
- `APP` = `backend/backend-app/src/main/java/com/fathy/alfred/backend`, `APP_T` its tests
- `SPI` = `backend/backend-teamboards/teamboards-spi/src/main/java/com/fathy/alfred/backend/teamboards/spi`
- `CORE` = `backend/backend-teamboards/teamboards-core/src/main/java/com/fathy/alfred/backend/teamboards/core`, `CORE_T` its tests
- `AZ` = `backend/backend-teamboards/teamboards-azure/src/main/java/com/fathy/alfred/backend/teamboards/azure`, `AZ_T` its tests (fixtures in `src/test/resources/azure/`)
- `ARCH` = `backend/backend-architecture-test/src/test/java/com/fathy/alfred/backend/architecture`
- `FE` = `frontend/src/app`, `MCP` = `mcp-server/src/tools`, `SK` = `skills`

---

## Phase 1: Setup

- [X] T001 [P] Add SPI read capabilities and models in `SPI/`: `ItemSearcher`, `ItemReader`, `TreeReader`, `QueryRunner`, `IdentityReader`, `StateCatalog`, `HookReader`; models `ItemQuery`, `ItemPage`, `ItemRef`, `FullItem`, `ItemTree`, `TreeRef`, `Part`, `TypeStates`, `NewItem` (contracts/connector-spi.md)
- [X] T002 [P] Add SPI write capabilities `ItemWriter`, `AttachmentWriter` in `SPI/`; remove `ItemIdsReader` and `Connector.changedItems`
- [X] T003 Schema 2 in `CORE/adapter/out/sqlite/SqliteTeamCacheRepository.java` (rename to `SqliteTeamRepository`): drop `items`, `item_fields`, `items_fts`, `revisions`, `links`, `changes`, `board_links`; add `item_types`, `item_states`, `areas`, `type_kind_map`, `board_items` (+ `ux_board_main`), `item_copies`, `item_syncs`, `card_links`, `incoming`, `watch_rules`, `azure_writes`, `azure_write_files`, `hook_settings`, `hook_waiting`, `me_override`; `people.unique_name/descriptor`; `meta('upgrade-notice-028')` (data-model.md)
- [X] T004 Test the migration on a schema-1 fixture written by the 027 repository in `CORE_T/adapter/out/sqlite/SchemaTwoMigrationTest.java` (old tables gone, notice flag set, mappings/people kept)
- [X] T005 [P] `TokenVault` in `CORE/application/service/TokenVault.java` (memory map, 8 h expiry, owner, forget, replace) + `TokenVaultTest`

## Phase 2: Foundational (blocks every story)

- [X] T006 `TokenController` (`PUT/GET/DELETE /teamboards/connections/{id}/token`) in `CORE/adapter/in/web/`; owner via `IdentityReader.whoAmI`; signal `what:"token"`; keep `TeamTokenLogFilter` for the PUT body; remove `X-Alfred-Team-Token` handling everywhere
- [ ] T007 [P] `TokenNeverPersistedTest` in `APP_T/teamboardsbridge/`: after PUT + search + approve, the token is absent from `teamboards.db`, `board.db`, logs and every response (SC-002)
- [X] T008 [P] Azure `IdentityReader` + `StateCatalog` in `AZ/AzureIdentities.java` (connectionData, identities by id, work item types with state categories) with fixtures; `AZ_T/AzureIdentitiesTest.java`
- [X] T009 Filter lists: `TeamListsService` refreshes types/states, areas, teams+members (joined to people, unknown ids fetched), iterations, people on tab open; `GET /connections/{id}/lists`; fixes members shown as raw ids (FR-013, FR-085)
- [X] T010 Remove refresh, changes feed, reconcile, refresh suggestions and their routes from `CORE` (`TeamService.refresh*`, `/refresh`, `/changes*`, `TeamChangeSignalPort.refreshed`) and their tests
- [X] T011 [P] Frontend token: `FE/core/team/team-token.store.ts` replaced by `team-state.service.ts` token status from the backend; token field + "token live · name · time left" + Forget in `FE/pages/team/team-page.component.ts`; remove `X-Alfred-Team-Token` from `team-api.service.ts`
- [X] T012 [P] Remove the Changes tab, `FE/components/team/changes-feed/`, `items-table` cache paging and the refresh button; one-time upgrade notice (FR-018)
- [X] T013 Azure `ItemWriter`/`AttachmentWriter` in `AZ/AzureWriter.java` (comments 7.1-preview.4, JSON-Patch state/tags/hyperlink, create, attachments upload + AttachedFile) with fixtures; `AzureWriterTest`
- [X] T014 ArchUnit: keep 027 rules; add "only `AzureWritesService` and the direct-action path call `ItemWriter`/`AttachmentWriter`" in `ARCH/TeamboardsArchitectureTest.java`

**Checkpoint**: Alfred starts on 027 data, the token lives in memory, lists load, the old cache is gone.

---

## Phase 3: US1 - Search live (P1)

- [X] T015 [P] [US1] Azure `ItemSearcher` in `AZ/AzureSearch.java`: Search API with filters → ids; fallback WIQL (`CONTAINS` + filter clauses, Open only from state categories, @current, @Me / uniqueName); `workitemsbatch` fields-only; sort; paging; `fullText` flag; fixtures (search on, search disabled 404)
- [X] T016 [P] [US1] Azure `QueryRunner` (WIQL SELECT only, ≤ 200) and `ItemReader` (`$expand=all`, comments, updates, ≤ 200 ids) in `AZ/AzureItems.java` + tests
- [X] T017 [US1] `TeamSearchService` + `TeamSearchController` (`POST /search`, `POST /query`, `GET/POST /items`, attachments) in `CORE`; board badges from `board_items` by (conn,item) with main flag and copy rev; error messages name the call
- [X] T018 [US1] `TeamSearchServiceTest` on a fake connector: page size ≤ 50, Open only default, badges, "changed since copy", no rows written (SC-001)
- [X] T019 [US1] Direct user actions: `PATCH /connections/{id}/items/{item}` (state, comment) executes now for the user and records a DONE bundle; as Claude creates a WAITING bundle (depends on T013 and T044)
- [X] T020 [P] [US1] Frontend search: `FE/components/team/search-form/` (text + filter chips incl. Open only, @current, me, changed within, tags, parent, area) and `results-table/` (50/page, sort, badges, Add ▾ placeholder) in `FE/pages/team/`
- [X] T021 [P] [US1] `FE/components/team/item-details/` (live fields, tree, comments, history; state move + comment going straight to Azure with the "via Alfred" footer); full-text-off banner; error banner
- [X] T022 [US1] Teams and Boards & Iterations browsers read the lists; clicking runs a filtered search (FR-016)
- [X] T023 [P] [US1] Specs: `search-form.component.spec.ts`, `results-table.component.spec.ts`

**Checkpoint**: quickstart 1-3 pass.

---

## Phase 4: US7 - A cycle holds only calls (P1)

- [X] T024 [P] [US7] `FE/pages/session-cycle-detail/`: remove Board and Task tabs and their code paths; add "Recorded for board X ↗ · also on Y ↗ · + Add to a board" from `GET /board/cycles/{id}/boards`; "Not on a board" state
- [X] T025 [P] [US7] `FE/pages/session-cycles-list/`: group by board lists each cycle under each board and under "Not on a board" (fix: cycles on no board vanished) + spec
- [X] T026 [P] [US7] New Cycle asks which board (default the board in context, or none) in the cycles list and board view
- [X] T027 [US7] Board Cycles tab (list + Record a cycle) in `FE/components/board/board-view/`

---

## Phase 5: US2 - Main item and tree (P1)

- [X] T028 [P] [US2] Azure `TreeReader` in `AZ/AzureTree.java`: descendants by WIQL `WorkItemLinks MODE (Recursive)`, ancestors by Hierarchy-Reverse walk, one hop of other links from relations, refs fields-only; cap → ASK; fixtures
- [X] T029 [US2] `BoardItemsService` in `CORE`: add item (first → MAIN), add by URL, make main (re-root, copy new main, demote old unless CARD), unlink (MAIN needs a replacement), siblings listed; `BoardItemsController` (`/boards/{board}/items`, `/main`)
- [X] T030 [US2] `ItemSyncService`: sync main + CARD items in full, diff field by field (`ItemDiff`), `item_syncs`, update refs, mark new descendants and LEFT_TREE, offer new ones to Incoming, ≤ 1/min on open, `keep`; `ItemCopyGc`
- [ ] T031 [US2] Tests: `BoardItemsServiceTest` (one main, re-root, demotion, 200 cap), `ItemSyncServiceTest` (diff kinds, new/left tree, keep), `ItemDiffTest`
- [X] T032 [US2] Start → main: `StartService` makes the started item the board's main through `BoardItemsService`; `SeedBuilder` reads the main's copy; 027 `team_link` maps to "add as main"
- [ ] T033 [US2] Task tab seed and re-seed offer from the main (brief, Acceptance items, children as steps) via the bridge into `backend-board`'s brief/requirements use cases; change in Azure → offer with before/after (FR-039)
- [X] T034 [P] [US2] Frontend `FE/components/team/related-items/` as the board's last tab: main strip + picker, Tree / By type, Kept column (full copy / reference), live drawer on click, Add by id/URL, Find in Team, Refresh all, Changed since last look; `item-diff` component for the sync diff and history
- [X] T035 [P] [US2] `FE/shared/utils/tree-layout.ts` (+ spec) and `item-diff.ts` (+ spec)

**Checkpoint**: quickstart 4-6 pass.

---

## Phase 6: US3 - Cards and Azure items (P1)

- [X] T036 [US3] Bridge ports in `CORE/application/port/out/`: `BoardSimilarPort`, `CardWriterPort` (new card as user/accepted proposal, insert pill, card exists/board of card), `CardsOfBoardPort`; adapters in `APP/teamboardsbridge/` over `backend-board` use cases
- [X] T037 [US3] `CardLinksService` + `CardLinksController` (`/cards/{card}/items` GET/POST/DELETE, `/create`): many to many, copy saved, pill inserted, markers as bundle steps, cleanup bundle on unlink/close-not-in-flow (FR-075), tag removal only when no other card links
- [X] T038 [US3] `IncomingService` + `IncomingController`: entries from TREE/RULE/HOOK/HAND/MCP once per board, close match, Claude proposals, New card (type → kind map, Features/Epics refused), Link, Ignore until a new rev
- [X] T039 [US3] Tests: `CardLinksServiceTest`, `IncomingServiceTest` (match first, proposal waits, ignore/re-open, kind map)
- [X] T040 [US3] Azure close/reopen of a linked item → card badge + move proposal (through the board's existing proposal mechanism) on sync
- [ ] T041 [P] [US3] Frontend card: "Linked in Azure" strip, pill opens the saved copy, Azure comments in activity ("from Azure"), Closed-in-Azure badge + proposal, Link another / Create in Azure dialogs in `FE/components/board/`
- [X] T042 [P] [US3] Frontend Incoming lane in the board view (`FE/components/team/incoming-lane/`): entries, "Looks like #n", Claude's proposal with Accept, New card / Link to card… picker (close matches first, other boards) / Ignore
- [X] T043 [P] [US3] Search row Add ▾ menu: New card on board…, Link to card…, Related items only, Start board (FR-060)

**Checkpoint**: quickstart 7-8 and 10 pass.

---

## Phase 7: US4 - Telling Azure (P2)

- [X] T044 [US4] `AzureWritesService` + `AzureWritesController` (`/writes` create/extend/list/edit/files/approve/reject): steps in order, per-step results, PARTIAL, waits with no token, `approve` refuses Claude, files deleted on end
- [X] T045 [US4] `AzureWritesServiceTest`: nothing written before approve (SC-004), ticks honoured, order, partial failure, Claude refused, "via Alfred" footer + link when the public address is set
- [X] T046 [US4] Tell Azure on Verified/Done: board status change → bridge → prepared bundle per linked item (state from the item's process, evidence summary, attachment request)
- [ ] T047 [P] [US4] Frontend consent bundle card `FE/components/team/consent-bundle/` (steps with ticks, edit, preview, size, "send unmasked" per file, Approve n steps, results); built exports with redactions (`export-file-io.ts` + redaction rules) uploaded to `/writes/{id}/files`
- [ ] T048 [P] [US4] "Also post to Azure" on the user's card comment (direct action); cleanup proposal on unlink / close as Not in this flow
- [ ] T049 [P] [US4] Redaction test: a call with an Authorization header exported for Azure is masked unless "send unmasked" is ticked (SC-007) in `FE/core/team/azure-export.spec.ts`

**Checkpoint**: quickstart 9 passes.

---

## Phase 8: US5 - Watch rules and hook (P2)

- [X] T050 [US5] `WatchRulesService` + controller: rules from the search body, run on board open / Refresh / hook / MCP, new matches → Incoming once
- [X] T051 [US5] `HookService` + `HookController` (`POST /teamboards/hooks/azure`): PBKDF2 secret, constant-time check, ids only (`AzureHookReader`), 60/min, bad pings counted, token live → fetch and route to boards (tree or rules), else `hook_waiting`, drain on token entry; settings routes (url, secret rotate/show once, public address, type → kind)
- [X] T052 [US5] Tunnel/edit-access exception for exactly `POST /teamboards/hooks/azure` in `APP/web/` (and the tunnel docs); test that every other write stays refused through the tunnel
- [X] T053 [US5] Tests: `WatchRulesServiceTest`, `HookServiceTest` (bad secret, waiting ids, routing, rate limit)
- [X] T054 [P] [US5] Frontend `watch-rules` (board settings, "+ Rule from the current search", Run now) and `hook-settings` (Settings → Team)

**Checkpoint**: quickstart 11 passes.

---

## Phase 9: US6 - People and me (P2)

- [X] T055 [US6] `PeopleService`: person card (teams, projects, live assigned count, board counts via `BoardMineCountsPort`), me = vault owner, `me_override` (cleared when the owner changes), `/people/{id}`, `/me`, `/mine` (eight sources: WIQL @Me/uniqueName for assigned/created/changed, `@RecentMentions`, `@Follows`; board side through the bridge)
- [X] T056 [US6] `backend-board`: `MentionType.PERSON` in `MentionParser` and indexing; `cards.owner` column, DTO, edit rule (Claude only on its own Inbox cards), export/import field; `board_search mine` (owned, mentioned, boards whose items are mine via port) + tests in `BOARD_T`
- [ ] T057 [P] [US6] Frontend `person-pill` + `person-card` (reusing `MentionChip`), `@` picker for people in the board editors and chat, owner on cards, "Mine" chip with the eight counts, "This is me"
- [ ] T058 [P] [US6] Specs: `person-pill.component.spec.ts`, `FE/shared/utils/mine-merge.ts` (+ spec)

**Checkpoint**: quickstart 12 passes.

---

## Phase 10: US8 - MCP (P2)

- [ ] T059 [US8] Rewrite `MCP/team.ts`: `team_search`, `team_query`, `team_item`, `team_tree`, `team_items_live`, `team_attachment`, `team_people`, `team_board_items`, `team_card_items`, `team_incoming`, `team_watch_rules`; writes `team_board_link/unlink`, `team_link_card/unlink_card`, `team_create_item`, `team_comment`, `team_move_state` (bundle create/extend, "waits for the user"); `team_propose_card`, `team_refresh_item`, `team_watch_run`; keep `team_start`, `team_link`; remove `team_items`, `team_changes`, `team_squads`
- [ ] T060 [US8] `MCP/board.ts`: `board_search mine`, owner in `board_get`/`board_edit`
- [ ] T061 [US8] mcp-server tests (each tool's REST call and the TOKEN_MISSING message) and `npx tsc --noEmit`

---

## Phase 11: US9 - Skills (P3) - same commit as Phase 10

- [ ] T062 [US9] `SK/_shared/rules.md`: token rule, live reads, full copy vs reference, consent-only writes with no bodies/secrets, person mentions and me, Azure arrivals as proposals; drop the cache tools
- [ ] T063 [P] [US9] `SK/alfred-setup`: Start/AB#/URL → team_item + team_tree, main + seed, team_board_link, watch-rule proposal, first cycle for the board
- [ ] T064 [P] [US9] `SK/alfred-triage`: Incoming first (team_incoming, board_similar, team_propose_card), then the Inbox; link proposals for cards matching open Azure bugs
- [ ] T065 [P] [US9] `SK/alfred-fix` (reads card items) and `SK/alfred-verify` (Tell Azure bundles; closed-elsewhere handling)
- [ ] T066 [P] [US9] `SK/alfred-sync` (Azure catch-up, diffs, proposals) and `SK/alfred-status` (Incoming, waiting bundles, Azure changes, on you)
- [ ] T067 [P] [US9] `SK/alfred-live` (Azure asks in chat, bundles), `SK/alfred-listen`, `SK/alfred-review` (propose links / Create in Azure)
- [ ] T068 [P] [US9] `SK/alfred-spec` (seed/re-seed from main), `SK/alfred-resume` (main + tree + diffs), `SK/alfred-report` (Azure side, Tell Azure draft), `SK/alfred-ask` (live reads only), `SK/alfred-guide` (Team flow); tool-name touch-ups in `SK/alfred-connect`, `SK/alfred-update-skills`
- [ ] T069 [US9] New `SK/alfred-team/SKILL.md` (contracts/mcp-and-skills.md) and register it in `alfred_skill.py` / installers
- [ ] T070 [US9] `python -m pytest -q tests/python` green (SC-008)

---

## Phase 12: Polish

- [ ] T071 Board export/import: `team-item` records (main copy, references, card links, incoming, watch rules, owner); 027 `workitem-snapshot` → main; `board-json.ts` and `ImportBoardService` + round-trip tests (FR-112)
- [ ] T072 [P] Docs: `docs/team.md` (rewrite), `docs/board.md` (Related items, Cycles tab, Incoming, owner, Tell Azure), `docs/mcp.md`, `docs/architecture.md` (SPI writes, vault, hook route), CLAUDE.md and AGENTS.md entries
- [ ] T073 Retention jobs (item_syncs 50/item, incoming 90 d, bundles 180 d, hook_waiting 7 d) + test
- [ ] T074 `docker compose build backend` (Dockerfile pom lines unchanged - no new module) and full suites once: backend `mvn test`, frontend `npm test` + `ng build`, mcp `npm test`, `pytest tests/python`
- [ ] T075 Coverage check: every decision on the mock's "Every decision" screen maps to an FR and a task (SC-005)
- [ ] T076 Walkthrough of quickstart.md against a real organisation with the user's PAT (user)

## Decision coverage (mock "Every decision" → FR → tasks)

| Decisions | FRs | Tasks |
|---|---|---|
| 1-5 search, filters, full text, errors | FR-010..012, FR-015 | T015-T018, T020-T023 |
| 6-7 filter lists, browsers | FR-013, FR-016 | T009, T022 |
| 8 badges on results | FR-014 | T017 |
| 9-10 upgrade, removals | FR-017, FR-018 | T003, T004, T010, T012 |
| 11-13 token | FR-001..004 | T005-T008, T011 |
| 14-16 Related items tab, many items, views | FR-030, FR-034, FR-041 | T029, T034, T035 |
| 17-23, 25-27 main, tree, copies, sync, diff | FR-030..033, FR-035..038, FR-040 | T028-T031, T034, T035 |
| 24 no saved searches | FR-115 | - |
| 28 MCP live reads | FR-090 | T059 |
| 29 Task tab seeded from main | FR-039 | T033 |
| 30-32 cycles | FR-100..103 | T024-T027 |
| 33-38 people, me, mentions, owner, Mine | FR-061, FR-085..089, FR-093 | T009, T055-T058, T060 |
| 39-42, 47-52 cards and Azure items, Incoming | FR-050..060 | T036-T043 |
| 43-46 public address, arrivals, hook, kind map | FR-054, FR-056, FR-080..083 | T050-T054 |
| 53-57 Tell Azure, bundles, cleanup, direct actions, footer | FR-070..076 | T013, T019, T044-T049 |
| 58-60 skills | FR-110, FR-111 | T062-T070 |
| 61 Start and mappings | FR-114 | T032 |
| 62 export | FR-112 | T071 |

## Dependencies

- Phase 1 → Phase 2 → stories. US1 and US7 independent. US2 needs US1's item reader. US3 needs US2 (copies, board items). US4's writer (T013) is needed by T019 and T037's markers; do T013 before T037/T044. US5 needs US3 (Incoming). US6 independent after Phase 2 (owner/PERSON in board slice). US8 needs US1-US6 routes. US9 ships with US8.

## Parallel examples

- Phase 1: T001, T002, T005.
- US1: T015, T016, T020, T021 together; then T017.
- US7: T024, T025, T026 together.
- US9: T063-T068 together after T062.
