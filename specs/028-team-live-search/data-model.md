# Data model: Team trackers live

All new tables are in `teamboards.db` (`teamboards-core`) unless marked `board.db`. Times are epoch ms. `conn` = connection id; `item` = the tracker's item id (text).

## Dropped (schema 1 → 2)

`items`, `item_fields`, `items_fts`, `revisions`, `links`, `changes`, `board_links`, `mappings`' item joins (mappings stay), the changes `seen` mark. A one-time `meta('upgrade-notice-028','1')` drives the Team tab notice.

## Kept / changed (filter lists)

| Table | Change |
|---|---|
| `people(conn, id, display_name, unique_name, descriptor, refreshed_at)` | + `unique_name`, `descriptor`; PK (conn, id) |
| `squads`, `squad_members(conn, squad, person)` | members joined to `people`; unknown ids fetched by identity id |
| `sprints`, `boards` | unchanged |
| `item_types(conn, project, name, color, icon)` | new |
| `item_states(conn, project, type, name, category, sort)` | new; category ∈ Proposed, InProgress, Resolved, Completed, Removed |
| `areas(conn, project, path)` | new |
| `mappings`, `field_maps`, `start_requests`, `pending_attachments` | unchanged |
| `type_kind_map(conn, type, kind)` | new; default Bug→BUG, Task/User Story/Product Backlog Item→TASK, Issue/Impediment→QUESTION, `*`→NOTE; Feature/Epic→NONE |

## New

### `board_items`
| Column | Type | Notes |
|---|---|---|
| board_id | TEXT | Alfred board id (opaque) |
| conn, item | TEXT | |
| role | TEXT | MAIN, CARD, REF |
| relation | TEXT | ANCESTOR, DESCENDANT, LINK, ADDED (by hand), SIBLING (listed only) |
| link_kind | TEXT | Related, Duplicate, Tested By, Predecessor, Successor… (LINK) |
| parent_item | TEXT | for the tree |
| depth | INT | 0 = main; negative = ancestors |
| type, title, state, state_category | TEXT | reference fields, refreshed each sync |
| rev | INT | |
| left_tree_at | INT | null unless moved/removed |
| added_at, added_by | | |

PK (board_id, conn, item). Partial unique index `ux_board_main ON board_items(board_id) WHERE role='MAIN'`. Index (conn, item) for badges on search results.

### `item_copies`
`(conn, item, rev, json, saved_at, kept_at)` - the full item (fields incl. custom, description, repro, acceptance, comments, relations, attachments list). Present only while some `board_items` row has role MAIN or CARD for it, or a `card_links` row exists; deleted otherwise (`ItemCopyGc` after unlink).

### `item_syncs`
`(id, conn, item, from_rev, to_rev, at, diff_json, kept)` - per sync; `kept=1` after "Keep Azure's version". Retention: last 50 per item.

### `card_links`
`(card_id, conn, item, linked_at, linked_by, hyperlink_written, tag_written, comment_id)` PK (card_id, conn, item).

### `incoming`
`(board_id, conn, item, source, arrived_at, rev, type, title, match_card, match_score, proposal_json, state, ignored_rev, decided_at, decided_by)`; source ∈ TREE, RULE, HOOK, HAND, MCP; state ∈ WAITING, CARDED, LINKED, IGNORED. PK (board_id, conn, item).

### `watch_rules`
`(id, board_id, conn, name, query_json, created_at, last_run_at, last_run_source, last_new)`.

### `azure_writes` (consent bundles)
`(id, board_id, card_id, conn, item, origin USER|CLAUDE, asked_in, title, steps_json, state WAITING|SENDING|DONE|PARTIAL|REJECTED, created_at, decided_at, decided_by)`.
Step: `{kind: STATE|COMMENT|ATTACH|HYPERLINK|UNHYPERLINK|TAG|UNTAG|CREATE|LINK_ALFRED, payload, ticked, unmasked?, result: {ok, message, azureId}}`.
`azure_write_files(write_id, step, name, size, bytes)` - deleted when the bundle ends.

### `hook_settings` / `hook_waiting`
`hook_settings(conn, secret_hash, rotated_at, last_ping_at, last_ping_event, bad_pings, public_address)`; `hook_waiting(conn, item, event, at)`.

### `me_override`
`(conn, person, set_at, token_owner_at_set)` - cleared when the vault's owner changes.

## board.db changes

- `cards.owner TEXT NULL` - `<conn>/<personId>|Display Name`.
- `MentionType.PERSON` - `@[person:<conn>/<id>|Name]`, re-indexed like other mentions.

## Memory only

`TokenVault`: `connId → {token, owner(person id, name, unique_name), enteredAt, expiresAt}`.

## Retention

- `item_syncs` 50 per item; `incoming` decided rows 90 days; `azure_writes` DONE/REJECTED 180 days, files deleted on end; `hook_waiting` 7 days.
- `teamboards.db` keeps its storage-budget share (027).
