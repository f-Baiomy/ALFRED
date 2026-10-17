# Implementation Plan: Task workflow

**Branch**: `030-task-workflow` | **Spec**: [spec.md](spec.md) | **Mock**: [mock-workflow.html](mock-workflow.html)

## Summary

One flow for every task - Board → Define → Triage → Code → Verify → Test → Close - built mostly by **extending what
exists**: the seed (`SeedBuilder`), the board sync (`POST /teamboards/boards/{board}/sync`), the card's items
(`card-items`, `POST /teamboards/cards/{card}/create`), consent bundles (`AzureWritesService`), the next-step text
(`nextStep` in `mcp-server/src/tools/task.ts`, `next-steps-bar`), and the skills. New code is small: board
resolution in the MCP server, the stage rule, item matches, and the skills' rewrite.

## Technical Context

- Backend: Java 21, Spring Boot, hexagonal slices; `backend-teamboards` (core + azure), `backend-board`; SQLite
  (`teamboards.db`, `board.db`). Build check: `docker compose build backend` (no new module, so no Dockerfile line).
- MCP server: TypeScript (`mcp-server/src`), tests `mcp-server/test` (node test runner).
- Frontend: Angular standalone + signals, zoneless; Karma specs.
- Skills: `skills/alfred-*/SKILL.md`, `skills/_shared/rules.md`; `tests/python/test_alfred_skill.py` checks every named
  tool exists; install with `python alfred_skill.py install`.
- Constraints carried over: the token never leaves `TokenVault`'s memory; Claude never holds it; only the user opens a
  board (`askedIn`); every tracker write except the user's own direct state/comment/field is a consent bundle; no
  polling; reuse components; at most one subagent.

## Constitution / project rules check

| Rule | How this plan keeps it |
|---|---|
| Only the user opens a board | New board stays a user action; setup fills a board, never opens one (`board_open` unchanged) |
| Nothing to Azure without approval | Define links only; verify / report / card button prepare bundles; direct writes are the user's own, in the UI |
| Token only in memory | Refresh and matching read through `Live` with the vault token, server side; MCP gets TOKEN_MISSING as today |
| No polling | Refresh is a button and the setup re-run; the hook only marks "changed" |
| Claude's board limits | Cards made as Claude land in the Inbox; moves only To do / In progress / Fixed; Verified, Done, close proposed |
| Reuse components | Banner and stage strip extend `next-steps-bar`; the Azure panel extends `card-items`; candidates show in `card-items` |
| Exports | Item matches travel in the board export (`TeamBoardItemsController` export) like `card_links` |

## Design

### D1. Seed: children in full, parents to the top (backend-teamboards)

`SeedBuilder.seed(...)` already fetches the children it lists (`live.items(ctx, unknown)`) and keeps only
`id · type · title · state`. Change:

- New record `SeedChild(id, type, title, state, assignedTo, purpose, steps, acceptance, context, comments, closed)` -
  built through the same `maps(conn, type)` field maps and `SeedContributor` parts the main item uses; `closed` from
  the type's state category (Completed / Removed) in `item_states`.
- New record `SeedParent(id, type, title, state, purpose, acceptance)` - walk `Parent` links up to the top (cap 6,
  loop guard), from the copy when held, else live.
- Grandchildren: titles only - `id · type · title · state`, from each child's `Child` links (one `live.items` batch).
- Comments: the item's and each child's discussion via the connector's comments reader (the one `team_item` uses).
- Seed record gains `children: List<SeedChild>` (replacing the string list; the old string form stays in
  `childrenLines` for older MCP clients) and `parents: List<SeedParent>`.
- MCP `team_item` (`mcp-server/src/tools/team.ts`): new seed parts `children` and `parents`, paged by `part` +
  `offset` exactly like the existing parts (`SEED_PARTS`); the head shows counts and the first page.

### D2. Board resolution everywhere (mcp-server)

New `mcp-server/src/board-ref.ts`:

```ts
resolveTask(client, arg): Promise<{ board: BoardSummaryRow; cycles: SessionCycle[] } | { candidates: … }>
```

Order: board id (`/board/boards` row id) → `AB#<id>` / `<conn>/<id>` / URL (board whose MAIN is that item:
`/teamboards/items/{conn}/{id}/seed` gives `board`, or `cache.boardsOfItem` via a new
`GET /teamboards/items/{conn}/{id}/boards`) → board name exact, then prefix (case-insensitive) → cycle id or name
(`findCycle`, then its board as today). Bare `#n` is rejected with "that is a card number - give the board".

Used by `task_context` (replacing `findCycle` at its entry), `board_record`, `board_home`, `board_cycle_verdicts`,
`get_brief`, `read_spec`, `board_requirements`, `board_steps`, `check_calls`' `cycle` arg when given a board (it takes
the board's recording or latest cycle). The runners (`alfred-live.mjs`, `alfred-listen.mjs`) call `task_context` /
`board_boards` and accept the same forms in `--cycle`/`--board`.

### D3. Board stage (backend-board + mcp-server)

The stage is computed, not stored. One function in `backend-board`
(`application/service/BoardStage.java`), served at `GET /board/boards/{id}/stage`:

| Stage | When (first that holds) | Next command |
|---|---|---|
| DEFINE | no brief | `/alfred-setup <ref>` |
| TRIAGE | Inbox cards, or questions waiting on the user | `/alfred-triage <ref>` (or "answer on the board") |
| CODE | To do / In progress cards and no Fixed card | write the code, then `/alfred-verify <ref>` |
| VERIFY | items NOT_FOUND / NO_EVIDENCE by the last verify, or To do cards with code questions open | `/alfred-verify <ref>` |
| TEST | Fixed cards, or items NOT_EXERCISED | press Record, `/alfred-listen <ref>` |
| CLOSE | every card Verified / Done / closed and every item marked | `/alfred-report <ref>` |

`<ref>` = `AB#<main id>` when the board has a main, else its name. `nextStep` in `task.ts` reads this endpoint
(falls back to its own order on an older backend). `/alfred-guide` reads `task_context`'s NEXT.

### D4. Refresh from Azure (backend-teamboards)

Reuse `POST /teamboards/boards/{board}/sync` (refreshes the main and card items' copies, diffs into `item_syncs`).
Extend its result (`SyncResult`) with:
- `newItems` - items now in the main's tree (children, parents' children) not on the board, and not yet in Incoming;
  they are added to Incoming as today.
- `comments` - new comments per item since the last copy (by comment id / date).
- `mainState` - the main item's state change, with `category` (Removed / Completed / Proposed) and iteration move.
- `matches` - D5's candidates for unlinked cards.
The board's `changed` mark from the service hook (`POST /teamboards/hooks/azure`) stays a mark only.

### D5. Item matches (backend-teamboards)

New table in `SqliteTeamCacheRepository`:

```sql
CREATE TABLE IF NOT EXISTS item_matches (board_id TEXT NOT NULL, card_id TEXT NOT NULL, conn TEXT NOT NULL,
  item TEXT NOT NULL, state TEXT NOT NULL, why TEXT, score REAL, at TEXT NOT NULL,
  PRIMARY KEY (card_id, conn, item));
```

`MatchService` (core, `application/service`): for each card of the board with no `card_links` row - candidates =
open Bug/Task items in the main's tree created after the card, scored by word overlap (title + text, stop words out)
and by an endpoint path the card names (`@[call:…]` mentions' paths, `/api/...` in its text). Score ≥ threshold →
`PROPOSED` (unless a `REJECTED` row exists). No model.

Endpoints (new, `TeamCardsController`):
- `GET /teamboards/cards/{card}/matches` - proposed candidates with score and `why`.
- `POST /teamboards/cards/{card}/matches/{conn}/{item}/link` - links (the existing `card_links` path), state LINKED,
  removes that item from other cards' proposals.
- `POST /teamboards/cards/{card}/matches/{conn}/{item}/reject` - state REJECTED, kept.
- `PUT /teamboards/cards/{card}/matches/{conn}/{item}/why` (as Claude) - Claude's reason replaces the code's.

MCP: `team_card_matches` (read, and `why` to judge) - add to the skills' allowed tool list.

### D6. Card's Azure panel (frontend)

Extend `components/team/card-items` (already in `card-drawer`):
- **Linked card**: "Azure ▾" → *Comment* / *State* / *Field* - the user's own direct write through the existing
  direct endpoints the item drawer uses (no bundle) - and *Draft with Claude*, which posts
  "`/alfred-team update card #<n>`" to the board chat (same posting path as Start) and shows the waiting bundle via
  `consent-bundle` when it lands.
- **Unlinked card**: the proposed matches first (Link / Not this one / Show others → the D5 endpoints), then
  *Create in Azure* → the existing `POST /teamboards/cards/{card}/create` (a bundle under the main item).

### D7. Board page: banner, stage strip, refresh (frontend)

- `components/team/new-board`: no change to posting (it already posts nothing); ▶ Start unchanged.
- `components/board/next-steps-bar`: becomes the stage strip - seven stages from `GET /board/boards/{id}/stage`, the
  current one marked, its command with Copy. With stage DEFINE it shows the "Not defined yet" banner: the command, and
  "Ask Claude in chat" (posts `/alfred-setup <ref>` to the board chat) enabled when the chat header's "who answers"
  is a live runner or a terminal.
- `pages/board/board-page`: "↻ Refresh from Azure" in the header when the board has a main → D4; the result line
  ("3 changes · 1 possible match · AB#61813 Closed by …") with a link to Related items; the main-closed banner.
- Re-read on the existing `/ws/board` signal - no polling.

### D8. Verify's question and the Azure update (backend-board + skills)

`board_ask` already takes options with `then`. Verify asks with three options; the second's `then` tells the next
run (`/alfred-fix <n>` path that records fixes) to also call `team_comment` + `team_move_state` as one bundle. State
choice: `team_move_state` reads the type's allowed states (`item_states`); target Resolved (Bug) / Closed (Task),
else the closest in the same category, named in the bundle text.

### D9. Skills

| Skill | Change |
|---|---|
| `_shared/rules.md` | §0: board refs (`AB#`, name, id; bare `#n` = card); **Item-type rules** (Epic, Feature/Story, Task, Bug, words) and **child-type rules** (Bug, Task, Investigation/Spike, Meeting, Test Case, other); "Azure says done"; matches; the seven stages |
| `alfred-setup` | Args board / item / words. Fill an existing board. Read `team_item` seed parts `children` + `parents`. Draft incl. cards; one Save all; `board_add_many` + `team_link_card` (askedIn = the user's save message, no markers). **Re-define**: before → after, removals one by one (board chat → `board_ask` per removal; terminal → ask in the conversation), new cards only after `board_similar`, closes via `board_propose`. **Refresh**: read the sync result, judge matches (`team_card_matches` why), propose. Epic: sections per Feature + offers |
| `alfred-spec` | Board args; points to rules for the shape; stays for targeted edits |
| `alfred-triage` | Planned cards: where / team / already written; "Record as fixed?" option |
| `alfred-verify` | Board args; three-option question; bundle state rule; reads stage |
| `alfred-listen` | Board args; recording cycle or "press Record" and wait (Fixed-only re-test unchanged) |
| `alfred-live`, `alfred-review`, `alfred-report`, `alfred-status`, `alfred-resume` | Board args; report's close bundle |
| `alfred-team` | "update card #n" (Draft with Claude), matches, create-in-Azure |
| `alfred-guide` | Seven stages, full skill table (17), board-page paths, Start vs New board |

### D10. Docs

`docs/team.md` (seed parts, refresh result, matches, card Azure panel), `docs/board.md` (stages, banner, define cards),
`docs/mcp.md` (board refs, `team_card_matches`), `CLAUDE.md` one line in the Team trackers paragraph.

## Testing

- Backend: `TeamServicesTest` (seed children/parents/grandchildren, closed child, comments, paging), new
  `MatchServiceTest` (score, reject remembered, link removes from others), `BoardStageTest` (each stage), sync result
  fields; ArchUnit unchanged. Then `docker compose build backend`.
- MCP: `board-ref.test.ts` (each form, `#n` refused, candidates), `task-context` with a board id, seed parts paging.
- Frontend: specs for the stage strip + banner, refresh line, card Azure panel (linked / unlinked / matches).
- Skills: `pytest tests/python/test_alfred_skill.py`.
- Full suites at the end of each phase (frontend, MCP, Python, backend).
- End to end on AB#61813 in Docker: New board → setup draft → Save all → triage → verify → listen; refresh; one card
  match; all bundles left waiting.

## Phases

1. **Backend + MCP** (D1-D5, D2): seed, board refs, stage, refresh result, matches. Commit.
2. **Skills** (D8, D9). Install. Commit.
3. **Frontend** (D6, D7). Commit.
4. **Docs + end to end** (D10). Commit.

## Risks

- Seed size for an Epic: Features in full can be large → parts are paged; the head carries counts only.
- Match noise: threshold tuned on the fake tracker and AB#61813; "Not this one" is permanent per card.
- Older MCP clients reading `children` as strings → `childrenLines` kept.
