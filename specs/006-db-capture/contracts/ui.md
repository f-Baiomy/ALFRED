# Contract: UI - the agreed mock is the visual specification

**Source of truth**: [../mock.html](../mock.html) (v5, agreed with the owner on 2026-10-04 over five iterations).
The implementation reproduces it: same layout, same order of elements, same labels and wording, same colours
(the `--db` teal `#2dd4bf` for everything database, amber for writes, red for deletes/failures, green for
transactions), same badges, same interactions. Where the mock and this table disagree, the mock wins; where the
mock and the spec disagree, raise it before building.

How the mock's code is used:
- **CSS**: the mock's rules were copied from Alfred's `styles.scss`. Rules that duplicate existing classes are
  **not** copied again - the real classes are used (`.call`, `.call-band*`, `.badge`, `.method-*`, `.status-*`,
  `.duration`, `.action-btn`, `.block-chip`, `.block-panel*`, `.dialog-backdrop`, `.dialog-card`,
  `.source-pill-*`, `.switch-dot`, `.cw-*`). Only the new rules move into `frontend/src/styles/_db-capture.scss`
  (`.db-chip`, `.db-window`, `.dbw-*`, `.r`/`.rh`/`.rd` rows, `.verb`/`.v-*`, `.g`/`.gb` tree, `.sup` markers,
  `.flags`/`.flag`, `.strip`/`.tseg`, `.trace`/`.loc`/`.hit`, `.rows-scroll.fixed`, `.rq-*`, `.sq-note`,
  `.infobox`/`.warnbox`/`.errbox`/`.empty-cap`, `.mark.*`, `.db-sw`/`.db-glyph`/`.db-more`, `.db-pop`).
- **Markup**: rebuilt as Angular templates with bindings. The mock builds HTML from strings; the app never does
  (`innerHTML` is forbidden for call data - Constitution I). SQL keyword colouring is done by splitting the text
  into typed tokens in a pure util and rendering `<span>`s from a template.
- **Behaviour**: the mock's JS shows intended behaviour; logic is re-implemented in tested `shared/utils` functions
  (below), with data from the REST API instead of in-page arrays.

## Mock element → component map

| Mock element | Component / util (new unless noted) | Notes |
|---|---|---|
| ◆ DB chip on the call card (`◆ DB 56 · 13 writes · 1 failed · 10 flags`), dimmed `◆ DB 0`, pulsing "live" | `app-db-chip` inside `app-call-card` (existing, request band / call-top, after the source badge) | reads `CallDbSummary`; hidden when the project has never been captured; shows "not captured" when capture was off |
| Database window (frosted dialog, title, sub-line, stats pills, ▴/▾ compact, ✕) | `app-db-window` (dialog, `.dialog-backdrop`/`.dialog-card.db-window`) | opened from the chip; Esc / backdrop closes |
| Flags row | `app-db-flags` + `shared/utils/db-flags.ts` (labels, order, severity) | flags come from the backend summary (research D11); click → `jump()` |
| Time strip + legend | `app-db-time-strip` + `shared/utils/db-time-strip.ts` | segments from statement/supplier offsets |
| Views: Statements · Tables (Compare is **deferred**, see below) | `app-db-window` tabs | |
| Tools: Search/SQL toggle, search box, All/Reads/Writes/Deletes/Failed, Supplier calls, Fill in values, Expand/Collapse all | `app-db-statement-tools` | SQL mode shows the `textarea`, ▶ Run, Clear, column list, "Try:" chips |
| Statement line (chevron, `#n`, verb badge, SQL with values, result, ms, +offset) | `app-db-statement-row` | marks: `BATCH ×n`; (`PAUSE`, `WHAT-IF`, `⚡ FAIL` are deferred) |
| Transaction / repeated-query tree nodes with branch lines | `app-db-statement-group` + `shared/utils/db-statement-tree.ts` | repeated runs start folded; rolled-back tx red |
| Supplier call marker lines with "show call ↗" | `app-db-supplier-marker` | jumps to the existing call card |
| Expanded detail tabs: Error · Deleted rows · Statement · Params (sets) · Rows · Generated keys · Before → after · Where in code | `app-db-statement-detail` | tab order as in the mock |
| Statement text with filled values / placeholders | `shared/utils/sql-render.ts` (tokens: keyword, value, placeholder, redacted, blob, out) | |
| Rows table: fixed 320 px, sticky header, loads 100 more on scroll, count line, Search/SQL bar with "Try:" chips, column sort | `app-db-rows-table` + `shared/utils/db-row-query-examples.ts` | data from `rows` and `rows/query` |
| Deleted rows tab (earlier read link, before-image, not captured + turn-on box, no-WHERE box, cascade warning, rolled-back note) | `app-db-deleted-rows` | |
| Value tracing bar (`Tracing … found in N places` → locations → ✕) and highlighting | `app-db-trace-bar` + `shared/utils/db-trace.ts` (merges backend hits with supplier body hits) | |
| Tables view | `app-db-tables-view` | click a table → filter |
| Statements-query result notes ("N statements match…", flattened by ORDER BY, summary table) | `app-db-statement-query-result` | |
| Footer: `Showing n of N statements`, hint, Copy all SQL, Export .sql | `app-db-window` | |
| Sources bar: `◆` switch + `▾` after each project's inbound dot; ▾ popover (switch, agent status, before-image tables, rows per result, "Show the ◆ DB chip", "All database settings →") | `app-sources-bar` (existing) + new `app-db-capture-popover` | switch disabled with tooltip while inbound logging is off |
| Cycle widget Sources popover: **Log DB** column, `-` for External, "agent not attached" warning, footer text | `app-cycle-widget` (existing) | same `cw-switch`, teal when on |
| Settings → Database capture card (Capture, Rows kept per result, Before-image, Flags thresholds, Expected, Ignore, Redaction) | `pages/settings` (existing) new section `app-db-capture-settings` | |
| Other states (DB 0, live, agent not attached banner, outside calls, rows over limit, deleting captured data) | chip states + `app-db-window` empty/over-limit states + `app-db-outside-window` | |

State: `core/state/db-capture-state.service.ts` (projects + agent status, summaries cache keyed by call id, one
`/ws/db-capture` socket); `core/services/db-capture-api.service.ts`; `core/models/db-capture.model.ts`.

## Differences from the mock decided after it was agreed

- **Redacted values**: the mock shows `national_id` and `card_token` as `•••• redacted` in the window. Per the
  analysis fix (spec FR-008), the window always shows every value; redaction masks only exports. The window's
  rows table and Params tab offer "Hide in exports" on a column instead, and Settings → Database capture's
  Redaction row lists the database-column rules.
- **Supplier markers** come from the agent's `HTTP_OUT` markers, matched to outbound calls (contracts/rest-api.md).

## Mock elements deferred to the Relive feature (do NOT build now)

The mock shows the full end-state. These parts wait for the later Relive feature (spec Stories 5-7):

- the **In Relive** tab, **⏸ Pause here in Relive**, **✎ Edit for replay** / what-if count, **Fail it instead**;
- the `PAUSE` / `WHAT-IF` / `⚡ FAIL` marks on statement lines;
- the **Compare** view and the Relive run card's `◆ DB … replayed … · compare` chip.

The components above are built so these slot in later without restructuring: `app-db-statement-detail` takes its
tab list from one array, and `app-db-statement-row` renders marks from one `marks` input.
