# UI contract: `mock.html` → implementation

The built UI MUST match [mock.html](../mock.html). This table maps every element of the mock to the component that
renders it, the endpoint it uses, and the requirement it satisfies. Wording, order of controls, colours (shared
theme tokens: `--purple`, level colours ERROR `--red`, WARN `--amber`, INFO cyan, DEBUG faint) and keyboard
shortcuts are copied from the mock. Anything the mock simulates (generated data, `setInterval` live feed, client-side
filtering) is replaced by the real backend; behaviour seen by the user stays the same.

Legend: C = component (`frontend/src/app/…`), E = endpoint (contracts/rest-api.md), FR = spec requirement.

## Shell

| Mock element | C | E | FR |
|---|---|---|---|
| Nav tab "Logs" with NEW badge, between Relive Cycles and Settings | `header` nav + route `logs` | - | - |
| Routes: sources list `/logs`, wizard `/logs/new`, structure `/logs/:id/structure`, explorer `/logs/:id` | `app.routes.ts` | gateway `$spa_page` | - |

## Sources screen

| Mock element | C | E | FR |
|---|---|---|---|
| Title "Log sources" + sub-text, "+ New source" | `pages/logs/logs-sources` | `GET /logs/sources` | FR-001 |
| Source card: name, "● following" pill, lines · stored · retention · raw mode | same | same + `/ws/logs input-progress` | FR-001, 005, 009 |
| Input rows: icon, kind + path/query, progress text, status pill (loaded / following / idle / raw unavailable / N unparsed), `⋯` menu (pause, resume, remove, edit) and "view"/"reload" | `components/logs/log-input-row` | `POST …/inputs/{id}/pause\|resume\|retry`, `DELETE` | FR-002, 004 |
| "N lines with a different structure" row + "Start new source" | `log-input-row` | `POST …/inputs/{id}/split` | FR-045 |
| "Paused: low disk space (N GB free, limit 2 GB)" row + Resume | `log-input-row` | `POST …/inputs/{id}/resume` | FR-046 |
| Card "Settings" → retention dialog (max size GB, max age days, validation message) | `logs-sources` | `PATCH /logs/sources/{id}` | FR-047 |
| In-place OpenSearch card "nothing copied · N pinned lines" | same | same | FR-008 |
| Note about write-only credentials | same | - | FR-008 |

## New source wizard

| Mock element | C | E | FR |
|---|---|---|---|
| Steps bar "1 · Input / 2 · Structure / 3 · Load" | `pages/logs/log-source-wizard` | - | - |
| Five kind cards (Upload, File on server, Follow a file, HTTP push, OpenSearch) with one-line descriptions | same | - | FR-002 |
| Per-kind forms: file chooser; `/logs` file select + hint; follow file + "start from"; push address + token (Copy / Regenerate) + NDJSON note; OpenSearch address, credentials, index, query, time range, mode segment (Import once / Import + follow / Browse in place), limits | `components/logs/log-input-form` | `GET /logs/server-files`, `POST /logs/uploads…`, `POST …/push-token` | FR-002, 003, 007, 008 |
| "Raw lines" segment Copy into Alfred / Keep file + positions with explanatory hint | wizard | - | FR-005 |
| "Next: preview structure →" | wizard | `POST /logs/structure/preview` | FR-010 |
| Load screen: progress bar, lines / bytes / time left / memory note / unparsed count, "new field found" notice, "Open explorer now →" | `components/logs/log-load-progress` | `/ws/logs input-progress` | US1 #1, FR-004 |
| Same-file warning (not drawn in mock; uses `ConfirmDialogService` wording "This file was already loaded into this source - load a second copy?") | wizard | 409 `DUPLICATE_FILE` | clarification Q1 |

## Structure editor (wizard step 2 and `⚙ Structure`)

| Mock element | C | E | FR |
|---|---|---|---|
| Same-structure banner "Same structure as ‹source› - settings reused" + checkbox + "Skip to Load →" (wizard only) | structure editor | `POST /logs/structure/preview` `matchingSource` | FR-048 |
| Header: "id 9f3a…", N fields, "sampled first 1,000 lines", hint | `pages/logs/log-structure-editor` | `GET/PUT …/structure` | FR-010 |
| Fields table columns: Field path · Type select · Format input · Detection (match %, "N invalid", "boolean?" link, "set by you") · Search select (Exact / Text / Not searched) · Role select · Sample | same | `GET …/fields/{label}/invalid` for the invalid link | FR-011..013 |
| "Sensitive" checkbox column after Role | same | - | FR-043 |
| Grouping levels: "Level N" badge, field select, sort select, "top level / child of N", ↑ move, ✕ remove, "+ Add level", rules hint | `components/logs/log-levels-editor` | - | FR-015, 022 |
| Summary template input + rule hint + live preview line | `components/logs/log-template-editor` (`shared/utils/logs-template.ts`) | - | FR-014 |
| Time zone select; Personal data segment (Show as-is / Mask until revealed / Redact at load) + hint | structure editor | - | FR-043, 044 |
| Default data view Table / JSON | structure editor | - | FR-020 |
| Edit mode: "Cancel" / "Save structure"; rebuild runs in background | same | `PUT …/structure` → `RebuildJob[]` | FR-012 |

## Explorer

| Mock element | C | E | FR |
|---|---|---|---|
| Header: source name, sub-text, "Saved views…" select, "☆ Save view", "⚙ Structure", "Sources" | `pages/logs/logs-explorer` | `…/views` | FR-033 |
| Query bar: pills coloured by op (= blue, ≠ red, exists green, text amber, range/time cyan) with ✕; free input with placeholder; Backspace removes last pill; time range select | `components/logs/log-query-bar` (`logs-query-parse.ts`, `logs-pills.ts`) | `POST …/lines` | FR-029, 032 |
| Autocomplete: fields (type icon) → values with counts, "exists", "search text"; ↑↓ / Tab / Enter / Esc | same | `POST …/fields/values` | FR-031 |
| Histogram stacked ERROR/WARN/INFO/DEBUG, legend, start/end labels, drag across bars → time pill | `components/logs/log-histogram` | `POST …/histogram` | FR-032 |
| Toolbar: Lines / Grouped / Patterns segment; grouped-only: Collapse all, to L1, L2, All, per-level sort selects, "lines" sort; Data Table/JSON segment; "Close all data"; "▶ Live / ❚❚ Live"; "N matches · X ms" | `logs-explorer` | - | FR-017, 019, 020, 026, 028 |
| Bulk bar (when anything selected): "N selected (M hidden by current filters)", Select all N matching, + children of selected (grouped), Compare (pick 2), Show selection only, Copy raw, Export… (.ndjson/.json/.md/.html), Comment on all, Pin (keep forever), Make Alfred calls · later, Clear selection, inline message line | `components/logs/log-bulk-bar` (`logs-selection.ts`, `logs-export.ts`) | `…/selection/export\|pin\|comment` | FR-039, 040, 041 |
| Sidebar: ROLES list; FIELDS with type icon, name (click → stats), presence %, hover actions; top values with counts and hover actions | `components/logs/log-field-sidebar` | `POST …/fields/values` | FR-018, 030 |
| Field actions ⊕ filter for · ⊖ filter out · ▥ toggle column (highlighted when on) · ∃ field present | shared `log-field-actions` | - | FR-030, 018 |
| Stats popover: type icon, name, "type · N values", p50/p95/p99/max tiles + distribution (top 10 % red) + range labels + quick actions (`> p95`, group by); text fields: distinct count + top 10 bars | `components/logs/log-field-stats-pop` | `POST …/fields/{label}/stats` | FR-025 |
| List header: children ⊞, data {}, select-all checkbox (indeterminate; shift = all matching), Time, Level, Summary hint or column headers with ✕, Duration | `components/logs/log-list` | - | FR-017, 018, 039 |
| Row: level stripe, children +/−, data ▸/▾, checkbox (shift-click range), time, level badge, `L1 · N below` / `sibling` / `‹field› missing` / `unparsed` chips, correlation colour dot, highlighted summary or column cells (status ≥ 500 red), duration bar (≥ 10 s red) + text, ⇥ open in drawer, 💬 count | `components/logs/log-row` | `POST …/lines`, `…/groups` | FR-017, 019, 022, 023 |
| Placeholder row "‹field› = X · no level-N line in the log"; "No ‹field› · N lines" bucket | `log-row` | `…/groups` | FR-022 |
| "N new lines · paused while you're scrolled · jump to newest" pill | `log-list` | `/ws/logs lines-added` | FR-028 |
| Data panel: level IDs + "full data, untruncated", Table/JSON segment, Copy, Open in drawer, "💬 Comment on the whole line" | `components/logs/log-data` | `GET …/lines/{id}` | FR-020, 023, 042 |
| Table view: hover actions, type icon, 💬 button (count, amber when present), path, full value (multi-line wraps) + inline comment cards | `components/logs/log-table-view` | `…/comments` | FR-020, 042 |
| JSON view: coloured tokens, ▾/▸ folding with "{ … N fields }", folded block "💬 N inside", per-line 💬 gutter, inline comment cards + editor (Cancel / Comment, empty → error) | `components/logs/log-json-view` (`logs-json-lines.ts` + `JsonTokensComponent`) | `…/comments` | FR-020, 042 |
| Patterns view: worst-level stripe, +/−, template with ‹placeholders›, ×count, expanded lines | `log-list` | `…/patterns` | FR-026 |
| Minimap condition select ("Errors + warnings" default, any pill) + "sampled" label above 5 M matches | `log-minimap` | `POST …/minimap` `condition` | FR-027 |
| Minimap strip: error/warn ticks, visible-window box, click to jump | `components/logs/log-minimap` | `POST …/minimap` | FR-027 |
| Drawer: level, time, "j / k move", ✕; summary; tabs Fields / Raw (bytes) / Context (±N, current highlighted) / Trace (waterfall bars, duration labels) / Comments (N) with field select, textarea, "Commenting pins this line" | `components/logs/log-drawer`, `log-trace` | `GET …/lines/{id}`, `…/context`, `…/trace`, `…/comments` | FR-021, 035 |
| Compare dialog: title, "Only differences" checkbox, "N of M fields differ", 3-column table with differing cells amber, "(absent)" | `components/logs/log-compare-dialog` | `POST …/compare` | FR-024 |
| Time range select opens on the viewer's last-used range per source (localStorage, try/catch); first visit = last 24 h of data | `log-query-bar` | - | FR-032 |
| Comment cards show the author profile's emoji + name; the editor uses the viewer's remembered profile (picker on first comment) | `log-json-view`, `log-table-view`, `log-drawer` | `GET /profiles` | FR-035 |
| Source delete: confirmation "N lines, N comments, N pinned lines will be removed" | `logs-sources` (`ConfirmDialogService`) | `GET …/delete-impact` | FR-001 |
| Keys: `j`/`k` move, `x` select, `J`/`K` extend, `Esc` clear, `Enter` open data, `/` search | `logs-explorer` host listener | - | US5 |
| Footer note about virtual scroll / keyset pages / WebSocket (mock-only explanation, not rendered in the app) | - | - | - |
