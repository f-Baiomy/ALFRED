# 017 - Board visuals: fixed blocks, HTML snippets, live data, interaction

Status: planned 2026-10-14. Mocks: `mockups/board-visuals-mock.html`, `mockups/board-visuals-more-mock.html`,
`mockups/html-snippet-mock.html` (the system-design demo in 2b and the before/after reply in 2c are the reference).

Goal: Claude and the user can explain with pictures, not only words - from small fixed blocks drawn by the board to full
HTML/CSS/JS pages that read Alfred's live data - without ever giving a snippet the power to act as the user.

Decisions already taken with the user:

| Topic | Decision |
|---|---|
| Fixed blocks + free HTML | Both (option C) |
| Network for snippets | **None** - only inline code and Alfred's own libraries |
| When a snippet runs | On open (a per-browser switch to click-to-run) |
| Colour syntax | `{red\|text}` (red, green, amber, blue, purple) |
| Libraries | Hosted by Alfred, pinned, offline (Docker image and native installers) |
| Every feature A-P and 1-12 | All in |

## 1. Requirements (each one is checked off by a test or a browser check)

### Fixed blocks (drawn by the board, no snippet code)

- **R1** Colour in Markdown `{red|text}`; HTML `span[data-color]` already exists - round-trips both ways.
- **R2** ```` ```stats ```` - lines `label | value | colour | note` → cards.
- **R3** ```` ```chart ```` - JSON `{type: bar|hbar|line|pie|area, labels, series:[{name, values, color}], line:{at,label}, unit}` →
  own SVG renderer (no library), hover values, ⬇ PNG; a bad spec shows the error and the source.
- **R4** ```` ```timeline ```` - lines `label | start | length | colour` → waterfall bars with a scale.
- **R5** ```` ```mermaid ```` - flow/sequence/state diagrams; Mermaid loaded from `/lib/` only when a text has one,
  `securityLevel: strict`, drawn inside the same locked frame as a snippet (built in phase 2): the SVG never enters
  Alfred's page, so it needs no sanitizer. A frame in a hidden tab waits until it is seen before drawing (text is measured).
- **R6** `[progress: a/b label]` → progress bar.
- **R7** `:::tabs` with `## Tab name` sections → tabs (G), in Markdown and in the editor's HTML (`div[data-tabs]`).
- **R8** All fixed blocks: direction per block, Scroll/Wrap respected, readable in .md export (source kept), drawn in .html export.

### HTML snippets (the locked frame)

- **R9** ```` ```html live ```` block (attributes `name="…" libs="…" files="…" height="…"`) and a whole text marked as a
  page (`<!-- alfred:page -->` first line, or the HTML-stored `div[data-page]`).
- **R10** Frame: `iframe sandbox="allow-scripts"` (never `allow-same-origin`, never `allow-popups`/`allow-top-navigation`/
  `allow-forms`), `srcdoc` = CSP meta + runtime + snippet. CSP:
  `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' <origin>/lib/; style-src 'unsafe-inline' <origin>/lib/;
  img-src data: blob: <origin>/lib/ <origin>/board/images/; font-src data: <origin>/lib/; connect-src 'none'; frame-src 'none'`.
  `'unsafe-eval'` is allowed (libraries need it; nothing can leave the frame).
- **R11** Runtime `window.alfred` (postMessage, one channel per frame, accepts messages only from `parent`): `theme`, `dir`,
  `card`, `data/on`, `state.get/set`, `action`, `ask`, `files`, `resize` (auto height), console + error capture.
- **R12** Host (`SnippetHostComponent` + `snippet-bridge.ts`) accepts messages only when `event.source === frame.contentWindow`,
  validates every message shape, rate-limits (≤ 50 msg/s, data ≤ 5 MB per answer).
- **R13** Theme colours as CSS variables + the comment's direction passed in; auto height (min 80, max 900 inline; ⤢ for more).
- **R14** Bar: ◈ name · author · live badge · 🔒 · ⤢ Full screen · ⧉ Pop out · `</>` Source · ⟲ Versions · ⬇ PNG · ⬇ .html · ⧉ Copy.
- **R15** Runs on open; off-screen frames are paused (IntersectionObserver → `alfred:pause/resume`, requestAnimationFrame
  stops naturally when the frame is `display:none`d); per-browser "click to run" switch.
- **R16** Size limit 256 KB per snippet source (backend), 2 MB per page with its files.

### Live data, interaction, reuse (A-P, 1-12)

- **R17 (B, 2)** Read bridge: declared `<script type="alfred/data" name src live>` or `alfred.data(src)`. Allowlist, GET only:
  `calls` (new `GET /board/data/calls`), `call` (one call's detail, masked), `statements` (`/db-capture/calls/{id}/statements`),
  `rows`, `logs` (`/call-logs/{id}`), `redis`, `cards`, `card`, `cycles`, `rules`. Masked like the board. Live: refetch on the
  `/ws` "calls changed" and `/ws/board` signals (no polling).
- **R18 (A)** Query blocks drawn by the board: ```` ```calls ```` (`endpoint`, `since` = `fix|<iso>|cycle:<id>|call:<id>`,
  `until`, `show: table(...)|chart(field)`), ```` ```sql ```` (a statement's rows), ```` ```logs ```` (a call's lines). Live.
- **R19 (C)** ```` ```compare ```` two call mentions → status/time/SQL/headers/body diff from live data.
- **R20 (D)** `!@[call:…]` alone on a line → expanded call view (status, timing, headers, body collapsible, SQL/log counts).
- **R21 (1, H)** Actions with consent: `reply`, `answer`, `run-skill`, `retest`, `move`, `flag`, `propose`, `rule` (interception
  rule draft opened in the rule editor), `open-call`. Every one → board dialog with the exact change → user clicks. Claude's
  limits still apply server-side. `[action: …]` buttons in Markdown use the same dialog.
- **R22 (E, F)** `[choose: A | B | C]` and ```` ```form ```` → posted as the user's reply under the comment
  (`**Answer** choice: B` / `field=value; …`), clears Needs decision like Answer.
- **R23 (3)** Saved state `alfred.state` → `snippet_state` (per snippet, key ≤ 100 chars, value ≤ 64 KB, history kept), shared,
  live through `/ws/board`.
- **R24 (4)** `alfred.ask(text, data)` → a skill run request to the cycle's chat (same road as ▶), first time per snippet needs
  consent; the answer (Claude's reply) resolves the promise.
- **R25 (5)** Library shelf at `/lib/<name>/<major>/…` from npm packages copied by `angular.json` assets (Chart.js, ECharts, D3,
  Plotly, Mermaid, Three.js, Preact + htm, Alpine.js, Tailwind (play CDN script), Marked, highlight.js, PapaParse, dayjs,
  lodash) + Pyodide fetched by `scripts/fetch_pyodide.py` (pinned, checksummed) into `public/lib/pyodide/`. Listed at
  `/lib/index.json` (name, version, files, size) for Claude and the editor.
- **R26 (6)** Multi-file snippets: `--- name.ext` sections; files served into the frame as blob URLs (`import "./chart.js"`
  rewritten), attachments usable as data files.
- **R27 (7)** ```` ```python live ```` → Pyodide in the frame, `alfred.calls()` → DataFrame, matplotlib figure shown.
- **R28 (8)** Console under the snippet (errors and `console.log`, last 200 lines), uploaded with the shot for Claude.
- **R29 (9)** Pages: named snippets attached to a card, a cycle (Brief tab area) or a project, shown as tabs; Claude and the user
  create/edit/delete (Claude only its own, like its Inbox cards rule? → Claude may create and edit pages it created).
- **R30 (10)** Pop-out: `/board/page/<id>` SPA route opens the page alone in a new window (same host, same bridge).
- **R31 (11)** After first render (and after each version) the runtime renders a PNG of the frame (html2canvas-style DOM
  snapshot from `/lib/`, canvases copied) → `POST /board/snippets/{id}/shot`; MCP `board_snippet_view` returns PNG + console.
- **R32 (12)** Versions: every save kept (`snippet_versions`), diff (source line diff + both rendered side by side), restore.
- **R33 (I)** Pin a block or snippet to the top of a card / brief as its dashboard; MCP `board_pin`.
- **R34 (J)** Widgets: save a snippet/block as a named project widget; use with `{{widget:name | key=value}}`; Claude lists
  with `board_widgets`.
- **R35 (K)** ⬇ PNG on every chart/diagram/snippet; .md export embeds PNGs.
- **R36 (L)** File attachments on comments (≤ 10 MB, types: csv json txt log har xml sql md pdf png jpg zip-not), kept with the
  card, ⬇ download, snippets read them, MCP `board_file` (read, text in parts) and `board_attach`.
- **R37 (M)** Block editors with live preview: chart (number grid), timeline, stats, mermaid, form, choices.
- **R38 (N)** Ask Claude in the editor: select text → ✦ (make a chart / shorten / translate to Arabic / as a table / custom) →
  run request to the cycle's chat → Claude's suggestion comes back to the editor to accept.
- **R39 (O)** Split preview (source ⇆ rendered) for long texts, pages and snippets.
- **R40 (P)** Slash data commands `/call /calls /sql /logs /compare /html /page` pick real data (searchable list).

### Claude, exports, docs

- **R41** MCP: Claude reads every block and snippet as written (source), `board_page_put`, `board_pages`, `board_snippet_view`,
  `board_pin`, `board_widgets`, `board_widget_put`, `board_file`, `board_attach`, `board_ask_result`(answers to snippet
  questions via existing `board_reply`), `board_lib` (the shelf). Tool-name test with the skills.
- **R42** Skills writing guide: when to use a fixed block, when a snippet, data via the bridge (never pasted numbers that go
  stale), no network, check the shot before saying ready, keep the summary line in text.
- **R43** Exports: .json lossless (pages, versions latest only?, state, files, widgets, shots as images); .html embeds the same
  locked frame with the data captured at export time (bridge replaced by a static answerer); .md keeps the source + PNG.
- **R44** docs/board.md "Visuals and snippets", docs/mcp.md, docs/architecture.md (new tables), CLAUDE.md line.
- **R45** Security tests: frame attributes, CSP string, bridge source check, allowlist, consent for every action kind,
  size limits, cleaner keeps snippet text inert (stored as code text, never as HTML).

### Notes from building (phase 2)

- Some embedded browsers refuse every request a sandboxed (opaque-origin) frame makes. `SnippetShelfService` probes
  once per page load; where /lib/ cannot be reached from the frame, the host reads the files itself (same origin) and
  the frame gets their code as data in its boot JSON: scripts are written in as blob URLs (`document.write`, so they run
  before the snippet), modules become blob URLs in an import map. Library code is never parsed as HTML. The ⬇ .html
  download always carries its libraries this way, so it opens offline.
- html2canvas cannot work inside the sandbox (it clones the page into a child frame it may not read), so it is off the
  shelf; the frame draws its own PNG (computed styles inlined into an SVG `foreignObject`, canvases copied as images).
- `/lib/` is served with `Access-Control-Allow-Origin: *` (module scripts from an opaque origin are CORS fetches) and
  `.mjs` as JavaScript - frontend/nginx.conf for Docker, `SpaPageFilter.libResponse` natively (`SpaPageFilterTest`).

## 2. Design

### Storage (backend-board, board.db)

```
snippets(id, owner_type CARD|CYCLE|PROJECT|COMMENT, owner_id, project, name, kind HTML|PYTHON, source, files_json,
         author, pinned, created_at, updated_at, version)
snippet_versions(snippet_id, version, source, files_json, author, at)
snippet_state(snippet_id, key, value, updated_by, at)           -- + snippet_state_history
snippet_shots(snippet_id, version, png BLOB, console TEXT, at)
board_files(id, card_id, cycle_id, name, mime, size, data BLOB, created_at)   -- like board_images
widgets(project, name, source, params_json, author, updated_at)
```

Inline ```` ```html live ```` blocks inside comments stay in the comment text (the comment is the source); they get an implicit
snippet row keyed `comment:<entryId>#<n>` only when they save state or a shot. Pages are rows of their own.

Cascade: deleting a card deletes its pages, state, shots, files (CallDeletionCascade untouched - snippets are not call data).

### Endpoints (all under `/board`, so the gateway and SpaPageFilter need no change)

```
GET/POST        /board/pages?owner=card:<id>|cycle:<id>|project:<p>
GET/PUT/DELETE  /board/snippets/{id}            (+ ?version=)
GET             /board/snippets/{id}/versions
GET/PUT         /board/snippets/{id}/state/{key}
POST/GET        /board/snippets/{id}/shot       (PNG + console)
GET             /board/data/calls?project&endpoint&since&until&limit   (boardbridge: compact rows + db summary)
POST/GET        /board/files, /board/files/{id}
GET/PUT/DELETE  /board/widgets/{project}/{name}
POST            /board/cards/{id}/pin
```

SPA route `/board/page/:id` → added to the gateway `$spa_page` map and `SpaPageFilter` page patterns (`SpaPageFilterTest`).

### Frontend

- `shared/utils/markdown-blocks.ts` - new block kinds: `stats`, `chart`, `timeline`, `mermaid`, `progress`, `tabs`, `snippet`,
  `query`, `compare`, `callview`, `choices`, `form`, `actions`, `widget`; `rich-html.ts` mirrors them in HTML (`div[data-block="chart"]`
  holding the source as text).
- Components: `chart-block`, `timeline-block`, `stats-block`, `mermaid-block`, `tabs` in markdown-view; `snippet-host`
  (+ `snippet-bridge.ts`, `snippet-runtime.ts` string, `snippet-csp.ts`), `snippet-bar`, `snippet-versions`, `page-tabs`,
  `query-block`, `compare-block`, `call-view`, `choice-block`, `form-block`, `action-chip`, `consent-dialog`, `file-chip`,
  `block-editor` dialogs, `split-preview`, `ask-claude` menu.
- Editor: toolbar entries ◈ HTML, ▤ Chart, ⏱ Timeline, ▦ Stats, ⬡ Diagram, ☐ Choice, ⧉ Tabs, 📎 File, ⇆ Split, ✦ Ask Claude;
  slash commands R40.

### MCP (mcp-server)

New tools in `src/tools/board-visuals.ts`; `readable()` keeps fences as-is (already Markdown); HTML-stored blocks convert to
their fence form.

## 3. Phases (each ends: unit tests + full suites for the touched layer, deploy, browser check, commit)

| # | Phase | Requirements |
|---|---|---|
| 1 | Fixed blocks: colour, stats, chart, timeline, progress, tabs, mermaid (lazy lib); editor toolbar + slash + block editors with preview for chart/stats/timeline/mermaid (M); ⬇ PNG for charts (K part) | R1-R8, R35 part, R37 part |
| 2 | Library shelf `/lib/` (npm + Pyodide script) + `/lib/index.json`; snippet host, runtime, CSP, bar, full screen, source, ⬇ .html/PNG, pause off-screen, click-to-run switch; ```` ```html live ```` in comments/descriptions/briefs; whole-text page mode; ◈ HTML editor with split preview (O) | R9-R16, R25, R39 |
| 3 | Backend: snippets/pages/versions/state/shots tables + endpoints; pages tabs on card/cycle/project; pop-out route; versions + diff; console; shot upload; saved state | R23, R28-R32 |
| 4 | Read bridge + `/board/data/calls` + live refetch; query blocks, compare, expanded call view; data slash commands | R17-R20, R40 |
| 5 | Actions with consent, choices, forms, action chips; ask Claude from a snippet and from the editor | R21, R22, R24, R38 |
| 6 | Multi-file snippets, files/attachments, Python (Pyodide), pins, widgets | R26, R27, R33, R34, R36 |
| 7 | MCP tools + skills writing guide + tool-name test; exports (.json/.html/.md); docs; security test suite; full suites; deploy; browser walk-through of every requirement | R35, R41-R45 |

## 4. Verification per requirement

Every R has: a unit test (frontend spec or backend test) and, for anything visible, a browser check on the deployed Docker
Alfred with the result recorded in the phase's commit message. Security (R10, R12, R21, R45) has a dedicated spec
(`snippet-security.spec.ts`) that fails if a sandbox flag or CSP directive is loosened, and a browser check that runs the
eight break-out attempts from the mock against the real host.
