# Implementation Plan: Team trackers live, linked to Alfred boards and cards

**Branch**: `028-team-live-search` | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md) | **Mock**: [mock.html](mock.html)
**Input**: Feature specification from `specs/028-team-live-search/spec.md` (builds on specs/027)

## Summary

Replace the Team tab's fetch-everything cache with **live search** against Azure DevOps, using a **token held in backend memory** (8 h, one per connection). A board keeps **one main item** saved in full and its **tree as references**. **Cards link to Azure items** (many to many), new Azure items wait in an **Incoming** lane, and every **write to Azure** is a step in a **consent bundle** the user approves. People become **pills** with an automatic "me". Watch rules and an **Azure service hook** bring new items in. The session cycle page keeps **calls only**. The MCP tools and the **/alfred-* skills** follow, plus a new **/alfred-team**.

## Technical Context

**Language/Version**: Java 21 (Spring Boot reactor), TypeScript strict Angular standalone + signals, TypeScript mcp-server, Markdown skills, Python (skills test).
**Primary Dependencies**: existing only (JDK `HttpClient` for Azure REST 7.1 and Azure Search; Spring Security's `BCrypt` is not on the classpath - the hook secret uses PBKDF2 from the JDK).
**Storage**: `teamboards.db` schema 2 (drops the item cache, adds board items, copies, syncs, card links, incoming, watch rules, consent bundles, hook); `board.db` + `cards.owner`; token in memory only.
**Testing**: JUnit 5 / Mockito / AssertJ / ArchUnit; Karma/Jasmine; mcp-server `npm test`; `pytest tests/python`; Azure connector on recorded JSON fixtures (search, WIQL links, identities, comments, patch).
**Target Platform**: Docker and native installs.
**Performance Goals**: search page < 3 s; Related items draw < 1 s (references, no Azure call); sync of main + 10 card items < 5 s; tree build ≤ 3 Azure calls + 1 batch per 200 refs.
**Constraints**: no polling (WebSocket signals); the token never persisted or echoed; exports never truncated; nothing written to Azure without approval (except the user's direct actions); leaf-slice isolation; older Alfreds still read exports.
**Scale/Scope**: tens of boards, ≤ 200 references per tree, ~20 MCP tools, 17 skills.

## Constitution Check

*Gate before research: passed with the deviations in Complexity Tracking. Re-checked after design: passed.*

- [x] **I. Security**:
  - Token: memory only (`TokenVault`), PUT body (never header), masked `Token.toString()`, `TeamTokenLogFilter` kept for the PUT route, test `TokenNeverPersistedTest` scans db files, logs and responses (SC-002).
  - Writes to Azure: only from an approved bundle or the user's direct action; `approve` refuses `X-Alfred-Actor: claude` (test).
  - Hook: the only tunnel-forwarded write route; secret checked with constant-time compare against a PBKDF2 hash; ids only; 60/min; bad pings counted.
  - Exports to Azure: redaction rules applied by default; unmasked only by the user's tick per file (SC-007).
  - DTOs `@Valid` (search page ≤ 50, ids ≤ 200, WIQL must start with SELECT and contain no `;`, comment ≤ 64 KB, file ≤ 60 MB); third-party HTML rendered through the sanitising markdown view only.
- [x] **II. Performance**: proxy path untouched; no polling (signals on `/ws/teamboards`, Related items sync ≤ 1/min on open); lists windowed with `LIMIT`; indexed `board_items(conn,item)`, `incoming(board_id,state)`, `azure_writes(board_id,state)`; retention (data-model.md).
- [x] **III. Architecture**: all tracker state in `backend-teamboards` (core + azure); the board slice gets only `cards.owner` and `MentionType.PERSON`; bridges in `backend-app/teamboardsbridge` (`BoardSimilarPort`, `CardWriterPort` for New card / pill insert, `BoardMineCountsPort`, `CardsOfBoardPort`); spi ↛ Spring; ArchUnit rules from 027 kept (connector ↛ core, teamboards ↛ other slices).
- [x] **IV. Style**: one use case per operation (`TeamSearchUseCase`, `BoardItemsUseCase`, `ItemSyncUseCase`, `CardLinksUseCase`, `IncomingUseCase`, `WatchRulesUseCase`, `AzureWritesUseCase`, `HookUseCase`, `PeopleUseCase`, `TokenUseCase`); records; outcome enums; constructor injection; frontend `inject()` + signals.
- [x] **V. Clean code / reuse**: `board_similar` (matches), `MentionChip` (work-item and person pills), `BoardActionsService` consent pattern (Azure bundle card reuses its dialog shell), export builders + redactions (attachments), `ChatProposalService`-style accept (proposals), 027 Start/seed (`SeedBuilder` reads the main's copy).
- [x] **VI. Verification**: services on fake ports; SQLite on `@TempDir`; thin `@WebMvcTest` controllers; Azure on fixtures; ArchUnit; frontend utils tested directly (`tree-layout.ts`, `item-diff.ts`, `mine-merge.ts`); skills test; full suites once at the end.
- [x] **Invariants**: exports untruncated (new `team-item` records); gateway regex unchanged (`teamboards` exists) + tunnel rule for the hook; docs updated (team.md, board.md, mcp.md, architecture.md, CLAUDE.md, AGENTS.md).

## Project Structure

### Documentation (this feature)
```text
specs/028-team-live-search/
├── spec.md  plan.md  research.md  data-model.md  quickstart.md  tasks.md  mock.html
└── contracts/  teamboards-rest.md  connector-spi.md  mcp-and-skills.md
```

### Source Code (touched)
```text
backend/backend-teamboards/
├── teamboards-spi/      ItemSearcher, ItemReader, TreeReader, QueryRunner, IdentityReader, StateCatalog,
│                        ItemWriter, AttachmentWriter, HookReader (+ models); changedItems/ItemIdsReader removed
├── teamboards-core/     adapter/in/web: TeamSearchController, BoardItemsController, CardLinksController,
│                        IncomingController, WatchRulesController, AzureWritesController, HookController, TokenController
│                        application/service: TokenVault, TeamSearchService, BoardItemsService, ItemSyncService,
│                        CardLinksService, IncomingService, WatchRulesService, AzureWritesService, HookService,
│                        PeopleService, ItemCopyGc; StartService/SeedBuilder read the main's copy
│                        adapter/out/sqlite: SqliteTeamRepository (schema 2 migration)
└── teamboards-azure/    AzureSearch, AzureTree, AzureWriter, AzureIdentities, AzureHookReader (+ fixtures)
backend/backend-board/   cards.owner, MentionType.PERSON, board_search mine, owner in export/import
backend/backend-app/teamboardsbridge/  BoardSimilarAdapter, CardWriterAdapter, BoardMineCountsAdapter, CardsOfBoardAdapter,
                         hook route in the tunnel/edit-access rule
frontend/src/app/
├── core/team/           team-api.service (new routes), team-state (token live, me), people.service, writes.service
├── components/team/     search-form, results-table (Add ▾ menu), item-details, person-pill + person-card,
│                        related-items (tree/type), item-diff, incoming-lane, consent-bundle, watch-rules, hook-settings
├── components/board/    board-view: Related items + Cycles tabs, card strip, owner, Incoming lane, "Also post to Azure"
├── pages/team/          Search / Teams / Boards & Iterations (Changes removed)
├── pages/session-cycle-detail/  calls only + boards banner
└── pages/session-cycles-list/   group by board + Not on a board; New Cycle board picker
mcp-server/src/tools/team.ts (+ board.ts touches)
skills/_shared/rules.md, skills/alfred-*/SKILL.md (16), skills/alfred-team/SKILL.md (new), alfred_skill.py list
docs/team.md, docs/board.md, docs/mcp.md, docs/architecture.md, CLAUDE.md, AGENTS.md
```

## Delivery phases (for /speckit.tasks)

1. **Setup**: SPI interfaces and models; schema 2 migration (drop cache, new tables); TokenVault.
2. **Foundational**: token routes + Team tab token UI; Azure identity/whoAmI; filter lists; remove refresh/changes/reconcile (backend, frontend, MCP).
3. **US1 Live search** (P1): Azure search + WIQL fallback, search API, board badges, item details live, direct state/comment, upgrade notice.
4. **US7 Cycles hold calls** (P1): cycle page, cycles list grouping, New Cycle board picker, board Cycles tab.
5. **US2 Main and tree** (P1): board items, copies, tree, sync + diff, Related items tab, main change + Task re-seed, Start → main.
6. **US3 Cards and Azure items** (P1): card links, pill + strip, Incoming lane, matches, proposals, New card mapping, Azure comments in activity, close badges, Add ▾ menu.
7. **US4 Telling Azure** (P2): writer SPI + Azure writer, consent bundles, Tell Azure on Verified, attachments with redaction, cleanup proposals, "via Alfred" footer, public address.
8. **US5 Watch rules and hook** (P2).
9. **US6 People and me** (P2): pills everywhere, person card, me/override, PERSON mentions, card owner, Mine.
10. **US8 MCP** (P2): tools rewritten/added/removed.
11. **US9 Skills** (P3): rules + 16 skills + /alfred-team (same commit as US8's tool names).
12. **Polish**: export/import, docs, full suites, mock walkthrough against a real org (user's PAT).

## Complexity Tracking

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Token held in backend memory (027 kept it in the browser) | MCP, hook and approved bundles run with no browser | Env var for the MCP: a second secret, and the hook still has none |
| SPI gains write methods (027: read-only) | The user asked to tell Azure (state, comments, items, links) | Copy-paste by hand is what the feature removes; every write is behind approval |
| One write route open through the tunnel (the hook) | Azure can only reach Alfred through it | LAN-only would drop hooks for cloud Azure; the route takes ids only and a secret |
| No file-store fallback for the new tables | Same as 027's `teamboards.db` | A file store for consent bundles and copies adds code with no user |
