# Research: Task Board (014)

Each entry: **Decision**, **Rationale**, **Alternatives considered**. No open NEEDS CLARIFICATION remains.

## R1. Where the board lives in the backend

- **Decision**: a new leaf slice `backend-board` with its own SQLite file `board.db` (`BOARD_DB_FILE`, default `/appdata/board.db`). Everything that needs another slice goes through `backend-app/boardbridge`.
- **Rationale**: same shape as `backend-triage` (leaf slice, own db, own WebSocket, bridge in `backend-app`). The board must not depend on calls, internal-calls, session-cycles, db-capture or logs, so `HexagonalArchitectureTest` gets one isolation rule and no new cross-slice edge.
- **Alternatives**: putting cards in `backend-session-cycles` (rejected: project boards exist without cycles, and it would grow a slice that is already large); reusing `backend-comments` (rejected: comments are per-call annotations with a different lifecycle; spec keeps them separate).

## R2. Persistence: SQLite only, no file fallback

- **Decision**: SQLite adapter only, behind `@ConditionalOnProperty(prefix="alfred.storage.board", name="type", havingValue="sqlite", matchIfMissing=true)` so the property shape matches other slices.
- **Rationale**: the file fallback exists for slices that HAD a flat file before SQLite (to migrate and opt out). The board is new; there is nothing to migrate. `backend-triage` set this precedent.
- **Alternatives**: a JSON file adapter (rejected: YAGNI, and a whole-file rewrite per edit is the pattern the constitution forbids at scale).

## R3. Keeping mentioned live calls alive (FR-025)

- **Decision**: the board does NOT copy call bodies. `backend-app/storage/CommentedCallsKept.referenced()` (which already keeps Relive step sources and stored-answer sources out of retention) also adds the ids of live calls mentioned by any card, via a new `ListMentionedCallIdsUseCase` in the board slice. Each mention also stores a one-line summary (method, path, status, time) so a call that is still gone - deleted by hand, or kept-calls rule switched off in Settings -> Storage - shows as a "removed" chip (FR-026).
- **Cache window**: `referenced()` is cached 5 minutes, so a newly mentioned call could be trimmed before the cache refreshes. The board calls an outbound `MentionedCallsChangedPort` whenever its set of mentioned live calls changes; the bridge implements it with `CommentedCallsKept.refresh()`. Checklist evidence mentions count too (owner type `CHECKLIST`). Card deletion cascades its mention rows, releasing its calls.
- **Rationale**: one implementation per behavior. "Calls something refers to survive the limits" already exists, has tests (`ReferencedCallsSurviveLimitsTest`), and covers inbound and outbound through both `KeptCallIdsPort`s. A copy in `board.db` would duplicate 28-38 KB per call, need its own retention, and drift from the live row.
- **Consequence for the spec**: FR-025 is met through retention, not through a copy; when the user turns the "keep referenced calls" rule off, mentions fall back to their summary. The spec text and SC-006 are amended to say this.
- **Alternatives**: full copy per card (rejected, above); copy only on eviction via `CallsRemovedPort` (rejected: the call is already gone when that fires, and a race with the cascade).

## R4. Removal of a session cycle (FR-034)

- **Bean wiring**: the session-cycles no-op default is `@ConditionalOnMissingBean(CycleRemovedPort.class)`, so the bridge adapter replaces it without a duplicate-bean failure.
- **Decision**: add an outbound port `CycleRemovedPort` to `backend-session-cycles` (called by the delete use case after a successful delete), implemented in `backend-app/boardbridge` by calling the board's `CycleRemovedUseCase`, which deletes the brief, spec files and checklist marks and sets `cycle_deleted = 1` on its cards.
- **Rationale**: same pattern as `InternalCallsRemovedPort` feeding `CallDeletionCascade`. No new cross-slice edge; session-cycles knows nothing about the board.
- **Alternatives**: the board checking cycle existence lazily on read (rejected: leaves orphan spec files forever, and every read pays a lookup).

## R5. Mention form in text

- **Decision**: mentions are stored inline in Markdown text as `@[type:ref|label]`, e.g. `@[call:in:5f2c…|POST /orders · 201]`, `@[stmt:5f2c…/88|INSERT ORDERS #88]`, `@[spec:<cycleId>/ODY-482-spec.md#acceptance|ODY-482-spec.md §Acceptance]`, `@[card:7|Discount not saved]`. Full grammar in [contracts/mention-syntax.md](contracts/mention-syntax.md). The backend extracts mentions from text on every save into a `mentions` table (for Linked lists, badges, kept calls); the text is the source of truth.
- **Rationale**: survives copy/paste and export; readable by Claude and by humans in a .md export; the label keeps a readable fallback when the item is gone; one parser (`shared/utils/mention-syntax.ts`) mirrored by one Java parser, both tested against the same vectors file in `specs/014-task-board/vectors/mentions.json` (the dynamic-token vectors precedent).
- **Alternatives**: rich-text JSON document (rejected: heavy editor dependency, unreadable exports); IDs only without label (rejected: removed items would show nothing).

## R6. The mention picker

- **Decision**: one `MentionPickerComponent` with tabs per type; each tab is fed by an existing list endpoint (calls/internal-calls/captured calls, `/db-capture` statements per call, `/call-logs`, Redis commands, cycle spec files, triage `exception_source`-style code locations from the card's calls, cycles, spacers, cards, rules). The Calls tab reuses `call-finder`'s query logic (search + direction + cycle scope) rather than forking it.
- **Calls tab**: `call-finder`'s search and paging are private to the component, so the Calls tab embeds `app-call-finder` whole and turns the chosen call into a mention; nothing is extracted or forked.
- **Rationale**: constitution V (reuse); the user asked for "a picker like the call picker, for everything".
- **Alternatives**: a single global search endpoint (rejected for v1: a new cross-slice query surface; can come later if typing speed needs it).

## R7. Rendering Markdown safely (spec viewer, descriptions)

- **Decision**: a small in-house block parser `shared/utils/markdown-blocks.ts` (headings, paragraphs, lists, ordered lists, code blocks, inline code, bold/italic, links, tables, mentions) producing a typed tree rendered by an Angular component with normal bindings. No `innerHTML`, no `bypassSecurityTrust*`. Links are rendered only for `http(s):` URLs.
- **Rationale**: constitution I forbids raw `innerHTML` for untrusted data; spec files and Claude text are untrusted. A dependency (marked, markdown-it) plus a sanitizer would be heavier than the subset needed.
- **Alternatives**: `marked` + DOMPurify (rejected: two new dependencies, still an `innerHTML` path).

## R8. Drag and drop

- **Decision**: `@angular/cdk/drag-drop` (`cdkDropListGroup`), already a dependency.
- **Rationale**: keyboard-accessible, no new dependency.

## R9. Live updates (FR-014)

- **Decision**: `/ws/board` "board changed" signal `{type, project, cycleId, cardId}` from `BoardNotificationPort` (WebSocket adapter in the slice, as triage does); the frontend re-fetches the affected page via `reconnectingSocket`. No timers.
- **Rationale**: constitution II, existing pattern (`TriageEventsWebSocketHandler`, `ServerSocketService`).

## R10. Edit access (FR-049)

- **Decision**: register an interceptor for non-GET `/board/**` in `backend-app/boardbridge` that asks `EditAccessUseCase` (backend-server) and refuses with 403 when access is denied, EXCEPT that reason `DOCKER_MODE` is allowed (Docker has no `.env` editing, but board edits are data, not settings - same exception `EditAccessInterceptor` makes for `/server/agents/attach`). The Cloudflare tunnel stays read-only. Exports are client-side and need only GETs.
- **Rationale**: one access rule (constitution V). `backend-board` stays independent of `backend-server`.
- **Alternatives**: no access check (rejected: the tunnel URL would let any viewer edit cards).

## R10b. Read-only UI (FR-049)

- **Decision**: the board reads `GET /server/settings/access` (existing, `ServerSettingsService.access()`) on open and on socket reconnect; `editable = allowed || reason == DOCKER_MODE`, the same rule as the backend interceptor. Not editable → edit controls hidden, "View only" chip, export kept.

## R11. Claude's limits (FR-041, FR-042)

- **Decision**: MCP requests send `X-Alfred-Actor: claude`. The board service applies the Claude rules whenever the actor is Claude: new cards forced to INBOX, status only TO_DO/IN_PROGRESS/FIXED, no scope, close, reopen, delete or checklist marks (409 with a clear message). The MCP tools also simply do not offer those operations.
- **Rationale**: the rule is a guardrail against an agent going too far, not a security boundary against a hostile caller (a hostile caller with edit access can do anything the UI can). Enforcing in the service makes it testable and keeps the MCP server thin.

## R12. "Looks like a closed card" (FR-020)

- **Decision**: each card has an optional `signature` = `<kind of signal>|<METHOD> <endpoint pattern>`, computed when its first call mention is saved: the bridge reads the call's method/url/status through `CallRefResolver` and normalizes the path with triage's `EndpointPattern` (exposed through a small use case in `backend-triage`, called from the bridge). A new INBOX card whose signature equals that of a CLOSED card gets the hint. For Claude the check is enforced in the backend at create time (the MCP server cannot compute signatures): a Claude card whose call links match a card closed as FINE or NOT_IN_FLOW is refused with 409 naming that card and its reason (SC-009); WONT_FIX does not block. `board_closed_reasons` still gives Claude the reasons to read (FR-043).
- **Rationale**: reuses triage's one endpoint-normalization; equality is cheap and indexed; "fuzzy match acceptable" per spec assumption.
- **Alternatives**: text similarity on titles (rejected: noisy, untestable).

## R13. Acceptance checklist items (FR-050, FR-051)

- **Decision**: items = list items (numbered or bulleted) under the first heading whose text contains "acceptance" (case-insensitive), parsed by `shared/utils/acceptance-items.ts` and by the backend on save (same vectors file). An item's key = SHA-256 of its whitespace-normalized text; marks are stored by `(cycleId, fileName, itemKey)`, so an unchanged item keeps its mark across a replace and a changed one starts unmarked. A mark has `actor` (always USER in 014) so the later Claude-marks feature needs no migration (FR-052).

## R14. Claude live strip (FR-044)

- **Decision**: in-memory status per project in the board slice (`PUT /board/agent-status`, `GET`), broadcast on `/ws/board`. Pause sets `paused=true`; the MCP `board_add` and `wait_for_calls`-driven loop read it and stop adding cards. Status reads as STOPPED when not updated for 10 minutes - computed on read, no scheduler; the frontend arms one one-shot timer to that deadline (allowed by constitution II: not a repeating refresh). While PAUSED the backend refuses Claude's card creation.
- **Rationale**: transient UI state; no persistence needed.

## R15. Export and import

- **Decision**: client-side builders like the existing exports: `board-md-builder.ts`, `board-html-builder.ts` (escapes everything, reuses `html-builder.ts` helpers), `board-json.ts` writing `alfred-board/1` one record per line (cards, then activity, then briefs/spec files/marks), streamed lines -> Blob via `export-file-io.ts`. Import parses the same format; renumbers clashing card numbers and rewrites `@[card:N|…]` mentions (spec edge case). The cycle export dialog gets two checkboxes; unchecked = byte-identical output (guarded by a test).
- **Rationale**: invariants: never truncate, never one big string, JSON is the re-import format. Import fixtures are built by the exporter, never by hand.

## R16. Projects and cycles

- **Decision**: a card has `project` (a name from `INTERNAL_CALL_SERVICES`, or `""` = "No project" for outbound-only installs). A card created inside a cycle defaults to the project with the most inbound calls in that cycle (computed client-side from the loaded calls), changeable in the drawer. The Cycle board lists a cycle's cards regardless of project.
- **Rationale**: session cycles have no project field (`SessionCycle` record); adding one is out of scope.

## R17. Retention

- **Decision**: cards, activity, briefs and spec files are kept until the user deletes them (spec: Done cards forever), like session-cycle capture. Seatbelts: spec file ≤ 5 MB, ≤ 50 files per cycle, card description/brief/comment ≤ 256 KB, title ≤ 300 chars, bulk ≤ 200 cards, list page ≤ 500 cards. All clamped server-side.
- **Rationale**: constitution II requires an explicit policy; a board is manual data, measured in KB. 2,000 cards with history is a few MB.

## R18. Performance checks

- **Decision**: card list query returns summaries only (no description, no activity), indexed on `(project, status)`, `(cycle_id)`, `(signature)`; the drawer fetches one card's detail and activity. Measure SC-005 (2,000 cards open + filter < 1 s) with a seeded test and record the number in docs.
