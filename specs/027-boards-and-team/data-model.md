# Data model: Boards rework and Team tab

## Part 1: `board.db` (backend-board)

### New tables

```sql
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,              -- 'default:<project>' | old cycle id (migrated) | UUID
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | DONE | ARCHIVED (BoardState)
  migrated_from TEXT,               -- old cycle name, shown once as a banner
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_boards_default ON boards(project) WHERE is_default = 1;
CREATE INDEX IF NOT EXISTS idx_boards_project_state ON boards(project, state);

CREATE TABLE IF NOT EXISTS board_cycles (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL,           -- session-cycles id, plain string (no cross-slice FK)
  related_by TEXT NOT NULL, related_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, cycle_id));
CREATE INDEX IF NOT EXISTS idx_board_cycles_cycle ON board_cycles(cycle_id);

CREATE TABLE IF NOT EXISTS board_boards (     -- undirected: stored once with a < b
  a TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  b TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  PRIMARY KEY (a, b), CHECK (a < b));

CREATE TABLE IF NOT EXISTS card_cycles (       -- related cycles; origin stays on cards
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL, PRIMARY KEY (card_id, cycle_id));
CREATE INDEX IF NOT EXISTS idx_card_cycles_cycle ON card_cycles(cycle_id);

CREATE TABLE IF NOT EXISTS board_activity (    -- board-level events (card activity stays in `activity`)
  id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  actor TEXT NOT NULL, kind TEXT NOT NULL,      -- RELATE_CYCLE | UNRELATE_CYCLE | RELATE_BOARD | MOVE_HOME_IN | MOVE_HOME_OUT | STATE | CREATED | MIGRATED | KEPT_CYCLE
  text TEXT NOT NULL, undo_json TEXT, at INTEGER NOT NULL, undone_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_board_activity ON board_activity(board_id, id);
```

### Changed tables

The key column is renamed and the data is not moved (research R1):

| Table | Change |
|---|---|
| `cards` | add `board_id TEXT NOT NULL` (home), indexed `(board_id, status)`; `cycle_id` keeps its meaning as the **origin cycle**; `cycle_deleted` now means "origin deleted" |
| `cycle_briefs`, `spec_files`, `checklist_marks`, `checklist_suggestions`, `card_spec_items`, `cycle_log`, `cycle_steps`, `item_evidence`, `item_call_results`, `item_cards`, `brief_comments` | `cycle_id` → `board_id` (`RENAME COLUMN`); table names kept, since a rename gains nothing and costs every query |
| `skill_runs`, `asks`, `board_images`, `board_files`, `snippets` | `cycle_id` → `board_id` |
| `chat_messages`, `chat_settings`, `chat_sessions`, `chat_terminal_items`, `chat_watches` | `cycle_id` → `board_id`; `''` rewritten to `default:<project>` |
| `mentions` | unchanged: `cycle_id` names the captured call's cycle |

### Migration (`BoardModelMigration`, runs once, guarded by `board_meta.key = 'boards_v1'`)

These steps run in one transaction:

1. **Rename** the columns in the table above, if not yet renamed (`PRAGMA table_info` check).
2. **Default boards**: for each distinct `project` in `cards` ∪ `chat_messages`, insert board `default:<p>` with `is_default = 1` and the name `<p>`.
3. **Briefed cycles**: for each distinct id in `cycle_briefs` ∪ `spec_files` ∪ chats with a non-empty key ∪ `item_evidence`:
   - insert a board with that id;
   - project = the project of its cards or chat, else the first default board;
   - name and `migrated_from` = the cycle name, read once through `CycleNamesPort`, falling back to the id;
   - add `board_cycles(id, id)`.
4. **Card homes**: `UPDATE cards SET board_id = cycle_id WHERE cycle_id IN (SELECT id FROM boards)`, then `UPDATE cards SET board_id = 'default:' || project WHERE board_id IS NULL`.
5. **Project chat**: `UPDATE chat_* SET board_id = 'default:' || project WHERE board_id = ''`.
6. **Unbriefed cycles**: each cycle id that cards reference without a board gets `board_cycles('default:<p>', cycle_id)`.
7. **Activity**: one MIGRATED row per created board.
8. **Mark done**: set `boards_v1` in `board_meta`.

Validation: a test builds an old-schema `board.db` (fixture made by the current repository code, not by hand) and asserts SC-001 counts before and after, and that a second run changes nothing.

### Domain records (new or changed)

```java
record Board(String id, String project, String name, boolean isDefault, BoardState state, String migratedFrom,
             Instant createdAt, Instant updatedAt, String updatedBy) {}
enum BoardState { OPEN, DONE, ARCHIVED }
record BoardRelations(String boardId, List<String> cycleIds, List<String> boardIds) {}
record BoardActivity(long id, String boardId, String actor, String kind, String text, String undoJson, Instant at, Instant undoneAt) {}
// Card gains: String boardId (home); List<String> relatedCycles. cycleId keeps meaning "origin".
// ChatKey(project, cycleId) becomes ChatKey(project, boardId); PROJECT_SCOPE resolves to "default:<project>".
```

### Card visibility on a board (FR-011), one query

```sql
SELECT … FROM cards c WHERE c.board_id = :b
UNION
SELECT … FROM cards c WHERE :all = 1 AND (
     c.cycle_id IN (SELECT cycle_id FROM board_cycles WHERE board_id = :b)
  OR c.id IN (SELECT card_id FROM card_cycles WHERE cycle_id IN (SELECT cycle_id FROM board_cycles WHERE board_id = :b))
  OR c.board_id IN (SELECT CASE WHEN a = :b THEN b ELSE a END FROM board_boards WHERE a = :b OR b = :b))
LIMIT :max
```

Every subquery hits an index. Summary columns only; descriptions are fetched on open.

### Retention (Principle II)

- `boards`, `board_cycles`, `board_boards`, `card_cycles`: bounded by what the user keeps. They are deleted with their board or card, the same documented policy as `cards` today.
- `board_activity`: at most `alfred.board.activity-max-rows` per board (default 2,000). On insert, the oldest rows beyond the cap are deleted, at most 200 per pass. Undo is offered only on rows still present.

### State rules

- A default board: `state` stays OPEN; it cannot be archived or deleted (`BoardOutcome.DEFAULT_PROTECTED`).
- Delete board: cards move to `default:<project>` (UPDATE), its relations cascade, its brief, spec, chat and requirement rows are deleted by `board_id`.
- Judging and finding homes skip boards with `state != 'OPEN'`.

## Part 2: `teamboards.db` (teamboards-core)

```sql
CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL,
  scope_json TEXT NOT NULL, fetched_at INTEGER, fetched_by TEXT, seen_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items (conn TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, ext_id TEXT NOT NULL,
  type TEXT NOT NULL, custom_type INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, state TEXT, assignee TEXT, squad TEXT,
  sprint TEXT, area TEXT, url TEXT NOT NULL, rev INTEGER NOT NULL, changed_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
  native_json TEXT NOT NULL, PRIMARY KEY (conn, ext_id));
CREATE INDEX IF NOT EXISTS idx_items_list ON items(conn, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_squad ON items(conn, squad, state);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(conn UNINDEXED, ext_id, title);
CREATE TABLE IF NOT EXISTS item_fields (conn TEXT NOT NULL, ext_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
  PRIMARY KEY (conn, ext_id, key));
CREATE TABLE IF NOT EXISTS revisions (conn TEXT NOT NULL, ext_id TEXT NOT NULL, rev INTEGER NOT NULL, by_name TEXT, at INTEGER NOT NULL,
  changes_json TEXT NOT NULL, PRIMARY KEY (conn, ext_id, rev));
CREATE INDEX IF NOT EXISTS idx_revisions_at ON revisions(at);      -- eviction oldest first
CREATE TABLE IF NOT EXISTS links (conn TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY (conn, from_id, to_id, kind));
CREATE TABLE IF NOT EXISTS people (conn TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT, PRIMARY KEY (conn, ext_id));
CREATE TABLE IF NOT EXISTS squads (conn TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, project TEXT,
  alfred_project TEXT, alfred_team TEXT, PRIMARY KEY (conn, ext_id));
CREATE TABLE IF NOT EXISTS squad_members (conn TEXT NOT NULL, squad TEXT NOT NULL, person TEXT NOT NULL, PRIMARY KEY (conn, squad, person));
CREATE TABLE IF NOT EXISTS boards (conn TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, project TEXT, team TEXT,
  columns_json TEXT, PRIMARY KEY (conn, ext_id));
CREATE TABLE IF NOT EXISTS sprints (conn TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, team TEXT, starts INTEGER, ends INTEGER,
  PRIMARY KEY (conn, ext_id));
CREATE TABLE IF NOT EXISTS changes (id INTEGER PRIMARY KEY AUTOINCREMENT, conn TEXT NOT NULL, ext_id TEXT NOT NULL, rev INTEGER NOT NULL,
  by_name TEXT, squad TEXT, at INTEGER NOT NULL, summary TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_changes ON changes(conn, at DESC);
CREATE TABLE IF NOT EXISTS mappings (id INTEGER PRIMARY KEY AUTOINCREMENT, conn TEXT NOT NULL, kind TEXT NOT NULL, -- SPRINT|SQUAD|AREA|PROJECT
  ext_value TEXT NOT NULL, alfred_project TEXT NOT NULL, alfred_board TEXT, UNIQUE (conn, kind, ext_value));
CREATE TABLE IF NOT EXISTS field_maps (conn TEXT NOT NULL, item_type TEXT NOT NULL, field TEXT NOT NULL,
  target TEXT NOT NULL, -- PURPOSE|STEPS|ACCEPTANCE|CONTEXT
  PRIMARY KEY (conn, item_type, field));
CREATE TABLE IF NOT EXISTS board_links (alfred_board TEXT PRIMARY KEY, conn TEXT NOT NULL, ext_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL, seen_rev INTEGER NOT NULL, UNIQUE (conn, ext_id));
CREATE TABLE IF NOT EXISTS start_requests (conn TEXT NOT NULL, ext_id TEXT NOT NULL, alfred_board_target TEXT NOT NULL,
  chat_message_id INTEGER, state TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (conn, ext_id));
```

### SPI records (`teamboards-spi`, no Spring)

```java
record Connection(String id, String kind, String name, URI baseUrl, Scope scope) {}
record Scope(List<String> projects, List<String> teams) {}
record Item(String extId, String type, boolean customType, String title, String state, String assignee, String squad,
            String sprint, String area, URI url, int rev, Instant changedAt, Map<String, String> fields,
            List<Link> links, String nativeJson) {}
record Link(String toId, String kind) {}          // Parent | Child | Related | PullRequest | …
record Revision(int rev, String by, Instant at, List<FieldChange> changes) {}
record FieldChange(String field, String from, String to) {}
record Person(String extId, String name, String email) {}
record Squad(String extId, String name, String project, List<String> memberIds) {}
record ProviderBoard(String extId, String name, String project, String team, List<String> columns) {}
record Sprint(String extId, String name, String team, Instant starts, Instant ends) {}
record Token(String value) { @Override public String toString() { return "Token[***]"; } }  // never printable
enum Capability { BOARDS, SPRINTS, SQUADS, REVISIONS, ATTACHMENTS, CUSTOM_TYPES, SEED }
```

### Retention (Principle II)

The whole store takes a share of the storage budget. When the share is exceeded, eviction runs in this order, at most 500 rows per pass:

1. `changes` rows older than `alfred.teamboards.changes-max-age-days` (default 90), and beyond `alfred.teamboards.changes-max-rows` (default 50,000) per connection.
2. `revisions`, oldest first.
3. `items` (with their `item_fields`, `links`, FTS row) not changed for the longest, **never** an item in `board_links`.

`people`, `squads`, `boards` and `sprints` are replaced on each Refresh and stay small.

### Attachments

Attachments are not cached in `teamboards.db`. Claude never holds a token (R11), so **the backend** fetches them, never /alfred-setup:

- **Start with a token** (the Team tab ▶ Start, or a Yes on Claude's suggestion, both from the browser): core downloads each attachment through `AttachmentsReader` (≤ 10 MB each, ≤ 50 MB per item) into `pending_attachments`. When /alfred-setup links the board (`team_link`), the bridge moves them into the board as spec files, then deletes the pending rows.
- **Start without a token** (from a board chat or the terminal): the attachments are listed on the board by name and link. The board shows "Fetch attachments", which any later viewer with a token can press.
- Oversized attachments are always listed by name and link only.

```sql
CREATE TABLE IF NOT EXISTS pending_attachments (conn TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, data BLOB NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (conn, ext_id, name));
```

Pending rows older than 24 h are deleted (the start was cancelled or never set up).

### Validation and limits

- `scope_json` holds at most 50 projects and 200 teams. `base_url` must be https, or http on localhost only.
- List endpoints clamp `limit` to `alfred.teamboards.max-limit` (default 200). Search text is at most 200 characters.
- Field maps: `target` comes from the enum. `field` is at most 200 characters.
