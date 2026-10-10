# Data Model: Task Board (014)

Storage: `board.db` (SQLite, slice `backend-board`). Domain types are Java records in `com.fathy.alfred.backend.board.domain.model`; TypeScript mirrors in `frontend/src/app/core/models/board.models.ts`.

## Enums

| Enum | Values |
|------|--------|
| `CardKind` | `BUG`, `TASK`, `NOTE`, `QUESTION` |
| `CardStatus` | `INBOX`, `TO_DO`, `IN_PROGRESS`, `FIXED`, `VERIFIED`, `DONE`, `CLOSED` |
| `Resolution` | `FINE`, `NOT_IN_FLOW`, `WONT_FIX` (only when status = `CLOSED`) |
| `Flag` | `URGENT`, `RISK`, `BLOCKER`, `AFFECTS_PROJECT`, `NEEDS_DECISION` |
| `Scope` | `NOT_DECIDED`, `IN_SCOPE`, `OUT_OF_SCOPE` |
| `Actor` | `USER`, `CLAUDE` |
| `MentionType` | `CALL`, `STATEMENT`, `LOG`, `REDIS`, `SPEC`, `CODE`, `CYCLE`, `SPACER`, `CARD`, `RULE` |
| `ActivityKind` | `COMMENT`, `CREATED`, `STATUS`, `KIND`, `SCOPE`, `FLAGS`, `RESOLUTION`, `REASON`, `TITLE`, `DESCRIPTION`, `LINK_ADDED`, `LINK_REMOVED`, `CYCLE`, `SPEC_REPLACED`, `REOPENED`, `IMPORTED` |
| `Mark` | `PASS`, `FAIL`, `CANT_TELL` |

## Card

| Field | Type | Rules |
|-------|------|-------|
| `id` | UUID string | primary key |
| `project` | string | `""` = No project; ≤ 100 chars |
| `number` | int | unique per project, assigned on create (max+1), never reused |
| `kind` | CardKind | required |
| `title` | string | 1-300 chars, trimmed |
| `description` | Markdown with mentions | ≤ 256 KB |
| `status` | CardStatus | Claude: create forces `INBOX`; moves only to `TO_DO`/`IN_PROGRESS`/`FIXED` |
| `resolution` | Resolution? | non-null iff `status = CLOSED` |
| `reason` | string? | ≤ 2,000 chars; only with a resolution |
| `flags` | Set<Flag> | any combination |
| `scope` | Scope | default `NOT_DECIDED`; `NOT_IN_FLOW` close sets `OUT_OF_SCOPE`; Claude may not set |
| `author` | Actor | who created it |
| `cycleId` | string? | session cycle it belongs to |
| `cycleDeleted` | boolean | set when that cycle is deleted (FR-034) |
| `signature` | string? | `<signal>|<METHOD> <endpoint pattern>`; for the closed-card hint (R12) |
| `createdAt`, `updatedAt` | ISO-8601 | `updatedAt` drives "stale" (> 5 days, open status) |
| `updatedBy` | Actor | who made the last change |

Concurrent edits (spec edge case "two tabs"): a PATCH carries only the fields it changes; each field is written on its own, so updates of different fields both apply and the later update of the same field wins. Every changed field writes its own activity entry, so both edits are in the history. No version check.

**State transitions**

```
            ┌──────── Reopen (user) ────────┐
            v                               │
INBOX ─→ TO_DO ─→ IN_PROGRESS ─→ FIXED ─→ VERIFIED ─→ DONE
  │        ↑ ↓          ↑ ↓         ↑ ↓        (any open status may move to any other open status; user only for VERIFIED/DONE)
  └──── Close (user): FINE | NOT_IN_FLOW | WONT_FIX ──→ CLOSED
```
- Any open status → `CLOSED` needs a resolution (user only).
- `CLOSED` → `INBOX` via Reopen clears resolution and reason (user only).
- Claude may set `TO_DO`, `IN_PROGRESS`, `FIXED` from any open status other than `VERIFIED`/`DONE`.
- Each transition writes one `ActivityEntry`.

## ActivityEntry

| Field | Type | Rules |
|-------|------|-------|
| `id` | long | autoincrement; order = id |
| `cardId` | UUID | FK, cascade delete with card |
| `actor` | Actor | |
| `kind` | ActivityKind | |
| `text` | Markdown? | for `COMMENT`: ≤ 256 KB; Claude comments carry sections (below) |
| `oldValue`, `newValue` | string? | for change kinds |
| `at` | ISO-8601 | |

Claude comment sections (FR-029) are required: a Claude comment without Did, Found and Next is refused. They are stored as Markdown with fixed headings: `**Did**`, `**Found**`, `**Next**`, optional `**Impact**`. The UI renders them as labelled parts.

## Mention (derived index)

Extracted from text on every save of a description, comment or brief; the text stays the source of truth.

| Field | Type | Rules |
|-------|------|-------|
| `ownerType` | `CARD` \| `ACTIVITY` \| `BRIEF` \| `CHECKLIST` | `CHECKLIST` = evidence of a checklist mark (owner id = `cycleId/fileName/itemKey`) |
| `ownerId` | string | card id / activity id / cycle id |
| `cardId` | UUID? | the card it belongs to (null for a brief or checklist evidence); rows cascade-delete with the card |
| `type` | MentionType | |
| `ref` | string | see [contracts/mention-syntax.md](contracts/mention-syntax.md) |
| `label` | string | one-line summary, kept for removed items |
| `callId` | string? | set for `CALL` mentions of live calls - feeds kept calls (R3) and call badges |
| `cycleId` | string? | the cycle the item lives in, when any |
| `direct` | boolean | true for a link added without text (Linked list "+ link") |

Index: `(callId)`, `(cycleId, callId)`, `(cardId)`.

## CycleBrief

| Field | Type | Rules |
|-------|------|-------|
| `cycleId` | string | primary key |
| `text` | Markdown with mentions | ≤ 256 KB |
| `updatedAt` | ISO-8601 | |

## SpecFile

| Field | Type | Rules |
|-------|------|-------|
| `cycleId` + `name` | string | primary key; name 1-200 chars, no path separators, ends `.md` or `.txt` (pasted text gets `.md` unless named) |
| `content` | UTF-8 text | ≤ 5 MB; ≤ 50 files per cycle |
| `size` | long | bytes |
| `uploadedAt` | ISO-8601 | |

Replace = overwrite content (no versions); writes `SPEC_REPLACED` activity on every card that mentions the file.

## ChecklistMark

| Field | Type | Rules |
|-------|------|-------|
| `cycleId`, `fileName`, `itemKey` | string | primary key; `itemKey` = SHA-256 of whitespace-normalized item text |
| `mark` | Mark | |
| `actor` | Actor | always `USER` in 014 (FR-052) |
| `evidence` | Markdown with mentions | ≤ 8 KB |
| `history` | list of `{mark, actor, at}` | appended on each change |

Item list itself is not stored: it is parsed from the spec file on read (R13).

## AgentStatus (in memory)

`{project, cycleId?, state: WATCHING|PAUSED|STOPPED, callsChecked, cardsAdded, lastCheckAt, updatedAt}`; read as STOPPED when `updatedAt` is older than 10 min (computed on read, no scheduler). While PAUSED, Claude's card creation is refused.

## Board query (list)

`project`, `cycleId?`, `kinds?`, `statuses?`, `flags?`, `author?`, `scopeNotDecided?`, `q?` (title/description text), `offset`, `limit` (clamped 1-500). Returns `CardSummary` rows (no description, no activity) plus `similarClosed: {number, resolution, reason}?` and `commentCount`.

## Schema (board.db)

```sql
CREATE TABLE cards (id TEXT PRIMARY KEY, project TEXT NOT NULL, number INTEGER NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, resolution TEXT, reason TEXT,
  flags TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL, author TEXT NOT NULL, cycle_id TEXT, cycle_deleted INTEGER NOT NULL DEFAULT 0,
  signature TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
  UNIQUE (project, number));
CREATE INDEX idx_cards_project_status ON cards(project, status);
CREATE INDEX idx_cards_cycle ON cards(cycle_id);
CREATE INDEX idx_cards_signature ON cards(signature);
CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  actor TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, old_value TEXT, new_value TEXT, at TEXT NOT NULL);
CREATE INDEX idx_activity_card ON activity(card_id, id);
CREATE TABLE mentions (owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, card_id TEXT REFERENCES cards(id) ON DELETE CASCADE, type TEXT NOT NULL, ref TEXT NOT NULL,
  label TEXT NOT NULL, call_id TEXT, cycle_id TEXT, direct INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_mentions_call ON mentions(call_id);
CREATE INDEX idx_mentions_cycle_call ON mentions(cycle_id, call_id);
CREATE INDEX idx_mentions_card ON mentions(card_id);
CREATE INDEX idx_mentions_owner ON mentions(owner_type, owner_id);
CREATE TABLE cycle_briefs (cycle_id TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE spec_files (cycle_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, size INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL, PRIMARY KEY (cycle_id, name));
CREATE TABLE checklist_marks (cycle_id TEXT NOT NULL, file_name TEXT NOT NULL, item_key TEXT NOT NULL, mark TEXT NOT NULL,
  actor TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '', history TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
  PRIMARY KEY (cycle_id, file_name, item_key));
```

Foreign keys on (`foreign_keys=true` in the JDBC URL, per connection). WAL mode, as other slices.

As built: times are stored as epoch milliseconds (INTEGER), so ordering by them is exact; `card_numbers(project, last)` remembers the highest number a project ever gave out (never reused after a delete); `mentions` carries `call_id` (any call, for badges) and `live` (1 for a live call - the kept-calls set), and its `owner_type` also takes `DIRECT` for links added without text.
