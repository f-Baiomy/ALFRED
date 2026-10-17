# Research: Team trackers live, linked to Alfred boards and cards

## Findings from the current code (027)

- `teamboards-core` keeps a full item cache: `items`, `item_fields`, `revisions`, `links`, `changes` (+ FTS5) filled by `TeamService.refresh` through `Connector.changedItems`. A real org (7,392 open items) produced 6,892 change rows on the first fetch; VS402337 forced date windows.
- The PAT lives in the browser (`core/team/team-token.store.ts`) and rides `X-Alfred-Team-Token` on refresh, history, Start and attachment fetch only. `TeamTokenLogFilter` hides it.
- `board_links` (teamboards.db) holds one item per board with a snapshot; `LinksService` and `LinkedWorkItemAdapter` (backend-app) serve it to the board.
- `MentionType.WORKITEM` exists in `backend-board`; mentions are re-indexed on every save.
- The session cycle page still has Calls / Board / Task tabs (`session-cycle-detail.component.html`, specs/014 US6); the cycles list's "Group by Board" shows only cycles related to a board.
- The board consent dialog (`BoardActionsService`) already gates snippet-requested board changes; chat proposals (`ChatProposalService`) carry Undo and acceptance.
- `teamboards.db` has no file fallback (027 Complexity Tracking).

## Decisions

### R1. The token moves into backend memory
- **Decision**: `TokenVault` in `teamboards-core`: `Map<connId, Held(token, owner, enteredAt, expiresAt)>`, 8 h, `ConcurrentHashMap`, never serialised. `PUT /teamboards/connections/{id}/token` (body, never header-echoed) resolves the owner (`GET _apis/connectionData`) and stores it; `DELETE` forgets. Every Azure call takes the token from the vault; `X-Alfred-Team-Token` is removed.
- **Rationale**: The MCP, the hook and consent execution run without a browser. Memory-only keeps "never stored" true (FR-001); the 027 log filter stays for the PUT body route.
- **Alternatives**: MCP env var (a second secret to manage), browser relay (no browser for hooks).

### R2. Live search through the SPI
- **Decision**: New SPI capability `ItemSearcher.search(Connection, Token, ItemQuery, Page) → ItemPage` and `ItemReader.items(ids, parts)`. Azure: full-text via `almsearch.dev.azure.com/{org}/{project}/_apis/search/workitemsearchresults` (POST, filters on System.WorkItemType/State/AssignedTo/AreaPath/IterationPath/Tags); on 404/403/`SearchServiceDisabled` fall back to WIQL (`CONTAINS` on Title + the same filters as WIQL clauses, `[System.State] NOT IN (Completed/Removed category states)` for Open only, read from work item types as today), ids → `workitemsbatch` 200 at a time. Paging by `$skip/$top` (search) or id slices (WIQL).
- **Rationale**: Search answers "find it"; WIQL keeps working on orgs without the search extension.

### R3. Drop the item cache; keep filter lists
- **Decision**: Drop `items`, `item_fields`, `items_fts`, `revisions`, `links`, `changes`, `board_links`, `start_requests`'s item join stays (start rows keep conn+id only), `pending_attachments` kept (Start). Keep/extend `people`, `squads`, `squad_members`, `sprints`, `boards`; add `item_types` (+ states with category) and `areas`. Migration on start: drop the tables, set `meta.schema=2`, record a one-time notice flag (FR-018).
- **Rationale**: User's choice "drop everything"; filter lists are small and change rarely.

### R4. Where board-item data lives
- **Decision**: In `teamboards.db` (the Team slice), keyed by `board_id` strings it does not interpret: `board_items` (references and roles), `item_copies` (full JSON per conn+id, shared by every board/card that needs it, ref-counted by `board_items.role in (MAIN, CARD)`), `item_syncs` (history), `card_links` (card id ↔ conn+id), `incoming`, `watch_rules`, `azure_writes` (consent bundles), `hook_settings`, `hook_waiting`. The board slice learns about them only through the `teamboardsbridge` (strip, pill details, card activity "from Azure", owner untouched).
- **Rationale**: Keeps `backend-board` free of tracker concepts (027 R8); one copy per item even when linked to several cards.

### R5. Main item and tree
- **Decision**: `board_items.role` = MAIN (exactly one per board with items; partial unique index), CARD (card-linked, not main), REF. Tree built from the main's copy relations: ancestors (walk `System.LinkTypes.Hierarchy-Reverse` up, live, one call per level) + descendants (WIQL `WorkItemLinks` query `MODE (Recursive)` from the main, one call) + one hop of other link types from the main's relations. References stored with `relation` (ANCESTOR, DESCENDANT(depth, parentId), LINK(kind)), type/title/state from one `workitemsbatch` (fields filter). Cap 200 → ASK.
- **Rationale**: Two to three Azure calls per sync, references small, tree drawable offline.

### R6. Sync and diff
- **Decision**: `ItemSyncService.sync(board)` (on Related items open ≤ 1/min per board, Refresh, `team_refresh_item`, hook) re-reads the main and CARD items in full (`$expand=all` + comments + revisions since rev), diffs against the copy field by field (text fields as before/after, comments by id, attachments by name, relations by target), stores `item_syncs(diff_json)`, updates references, marks new descendants (→ Incoming for boards whose main they descend from) and LEFT_TREE. "Keep Azure's version" moves the copy forward; until then the diff stays shown.
- **Rationale**: FR-036/037; the user sees what changed before accepting.

### R7. Incoming lane
- **Decision**: `incoming(board, conn, item, source, arrived_at, rev, match_card, match_score, proposal_json, state)`; unique (board, conn, item). Close match from `backend-board`'s existing `board_similar` through the bridge (`BoardSimilarPort`). New card goes through `ManageCardsUseCase` as the user (or accepted Claude proposal), then `card_links` + copy. Ignore stores `ignored_rev`; a later rev re-opens it.
- **Rationale**: Nothing becomes a card unasked (decision), reuses dedupe.

### R8. Card links in the card
- **Decision**: Linking writes the pill into the card description through the board's own edit path (`BoardService.edit` as the actor), so mentions index it (027 WORKITEM). The strip and "from Azure" activity are rendered by the frontend from `GET /teamboards/cards/{cardId}/items` (copy summary + state + diff flag) - not stored as board activity rows (no duplication, no new ActivityKind: older Alfreds throw on unknown enum values).
- **Card owner**: a nullable `owner` TEXT column on `cards` holding `<conn>/<personId>|Name`; exported as an optional field (older importers ignore unknown JSON fields - verified for the card record).

### R9. Writes to Azure: SPI and consent
- **Decision**: New SPI write interfaces (the 027 rule "no write methods" is lifted deliberately, Complexity Tracking): `ItemWriter` (`comment`, `moveState`, `create`, `addHyperlink`, `removeHyperlink`, `addTag`, `removeTag`), `AttachmentWriter` (`upload` → url, then link to item). Azure: `PATCH _apis/wit/workitems/{id}` JSON-Patch (state, tags, relations), `POST .../comments?api-version=7.1-preview.4`, `POST _apis/wit/attachments` + relation `AttachedFile`, `POST _apis/wit/workitems/${type}`.
- **Consent**: `azure_writes(id, board, card, origin USER|CLAUDE, asked_in, steps_json, state, created_at, decided_at)`; steps carry kind + payload + ticked + result. Claude's tools only create/extend WAITING bundles. `POST /teamboards/writes/{id}/approve` (edit access, never Claude) executes ticked steps in order with the vault token; each result stored; the card/board gets a signal. The user's direct actions (Team tab state/comment, "Also post to Azure") call the writer at once and are recorded as a DONE bundle (audit).
- **Rationale**: One place for every Azure write; Claude cannot approve (X-Alfred-Actor: claude refused on approve).

### R10. Attachments from exports
- **Decision**: The frontend builds the export (existing builders, never truncated) with redaction applied (`redactions` rules) unless the user ticks "send unmasked"; uploads it to `POST /teamboards/writes/{id}/files` (stored with the bundle, max 60 MB, deleted after send/reject); the step references it. Claude's `team_comment attach=calls` names call ids and a format only; the bundle stores that request, and the export is built in the browser when the user opens the consent card (preview + size), so redaction runs where the export code lives and Approve stays disabled for that step until the file is built.
- **Rationale**: Exports are built in the frontend today (`export-file-io.ts`); no server-side duplicate builder.

### R11. Hook
- **Decision**: `POST /teamboards/hooks/azure` with basic-auth password = secret (bcrypt-hashed in `hook_settings`), body Azure service-hook JSON; read only `resource.id`/`resource.workItemId` and `eventType`. Allowed through the tunnel: added to the gateway as the one write route the tunnel forwards (tunnel config + `BoardEditAccess`-style rule exception for this path only). Rate-limited (60/min). Token live → `ItemSyncService.ping(ids)`; else `hook_waiting`.
- **Rationale**: FR-081/082; ids only keeps the unauthenticated surface tiny.

### R12. People and "me"
- **Decision**: `people` gains `unique_name`, `descriptor`; members resolved by id (fixes the raw-id bug: `squad_members` joined to `people`, missing ones fetched by `_apis/identities?identityIds=`). Me: the vault's owner per connection; `me_override(conn, person, until_token_change)` row for "This is me" (MCP and browser); the browser keeps its own override in `localStorage` only as a display preference. `MentionType.PERSON` added to `backend-board` (older Alfreds reading a board export with PERSON mentions: mentions are re-parsed from text, not exported as enum values - verified).
- **Mine**: `TeamService.mine(conn)` runs five WIQL clauses live (`@Me` cannot be used with PAT of another? `@Me` resolves to the token owner - used when no override; with an override, the person's uniqueName) + `@Follows` (WIQL `[System.Id] IN (@Follows)`) + mentions (`@RecentMentions`); board-side three counts through the bridge (`board_search mine`).

### R13. Cycles hold calls only
- **Decision**: Remove the Board and Task tabs from `session-cycle-detail` (keep the calls view), add the boards banner from `GET /board/cycles/{id}/boards` (exists in 027). Cycles list: `groupBy board` puts each cycle under every board it is on plus "Not on a board". New Cycle dialog gets a board picker (default the board in context).
- **Rationale**: Completes 027's model.

### R14. MCP tools
- **Decision**: `mcp-server/src/tools/team.ts` rewritten: reads call the new REST routes; write tools call `POST /teamboards/writes` (create/extend a bundle) with `X-Alfred-Actor: claude` and return the bundle id + "waits for the user". `team_items`, `team_changes`, `team_squads` removed. Tool inputs validated with zod; outputs compact, masked by session settings.

### R15. Skills
- **Decision**: Update `_shared/rules.md` + 16 skills per the mock's Skills screen; add `skills/alfred-team/SKILL.md`; register in `alfred_skill.py` list and installers (`build_dist.stage_app` copies `skills/` whole). Same commit as the MCP tools so `test_alfred_skill.py` stays green.

### R16. Export / import
- **Decision**: Board export adds `team-item` records (main copy JSON, references, card links, incoming, watch rules, card owner). Import: 027's `workitem-snapshot` record becomes the main (decision). Older Alfreds skip unknown record kinds (027 R15).
