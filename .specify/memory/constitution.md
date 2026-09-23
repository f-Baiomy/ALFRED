<!--
Sync Impact Report
- Version change: (template, unversioned) → 1.0.0
- Modified principles: n/a (first ratification; all placeholders replaced)
- Added principles:
  I. Security by Default
  II. Performance at Real Scale
  III. Hexagonal Vertical Slices (NON-NEGOTIABLE)
  IV. Match the Existing Code Style
  V. Clean, Maintainable Code
  VI. Verified Changes
- Added sections: Architectural Invariants; Development Workflow & Quality Gates; Governance
- Removed sections: none
- Templates:
  ✅ .specify/templates/plan-template.md (Constitution Check now lists concrete gates)
  ✅ .specify/templates/spec-template.md (no change needed: no mandatory sections added/removed)
  ✅ .specify/templates/tasks-template.md (no change needed: task types already cover tests/polish;
     security and performance tasks derive from the plan's gates)
  ✅ .specify/templates/checklist-template.md (no change needed)
  ⚠ .specify/templates/commands/*.md: directory not present in this install; nothing to check
- Runtime guidance: CLAUDE.md, AGENTS.md, docs/*.md remain the detailed source of truth; this
  constitution references them rather than duplicating them. No edits required.
- Deferred TODOs: none
-->

# Alfred Constitution

## Core Principles

### I. Security by Default

Alfred sees every request and response body, header, cookie and token that flows through a
customer's Java app. That data MUST be treated as sensitive at every layer.

- Every inbound boundary MUST validate its input: backend DTOs use Bean Validation (`@Valid`) and
  errors surface through `GlobalExceptionHandler`, never through ad-hoc try/catch in controllers.
- Every client-supplied size, limit or offset MUST be clamped server-side (as `GET /calls?limit=`
  is). No endpoint may let a caller request unbounded work.
- Secrets (webhook secret, credentials, tokens) MUST come from environment/config
  (`.env`, `settings.properties`), never from source code, logs, commits or test fixtures.
- Webhook endpoints MUST honor the `X-Webhook-Secret` check; new webhooks follow the same shape.
- Logs MUST NOT print call bodies, auth headers or cookies. Log identifiers and sizes instead.
- Frontend code MUST NOT bypass Angular sanitization (`bypassSecurityTrust*`, raw `innerHTML`)
  for call data. Call data is untrusted input from third parties.
- Generated artifacts (exports, HTML reports) MUST escape call data so a captured payload can
  never execute in a reader's browser.
- New dependencies MUST be justified, maintained and pinned; do not add a library for what a few
  lines of existing code already do.
- Failures MUST be loud: adapters never swallow I/O errors silently (SLF4J WARN/ERROR), and
  writability is checked at `@PostConstruct`.

Rationale: the tool exists to capture production-like traffic. A leak or an injection through a
captured payload is the worst failure this project can have.

### II. Performance at Real Scale

Every change MUST hold up under real row counts, real body sizes (~28–38 KB average per call,
some far larger) and concurrent traffic — not only under small test fixtures.

- Nothing on a proxied request's path may block: mitmproxy addons MUST use `await asyncio.sleep()`
  in `async def` hooks, never `time.sleep()`, and MUST NOT call the backend synchronously except
  for a deliberately PAUSED call (which always carries a timeout and default action).
- No polling. Lists are fetch-on-demand, driven by a WebSocket "something changed" signal, opened
  via `reconnectingSocket`. A recurring refresh (`interval()`, `timer(n, period)`, `setInterval`)
  is a violation; a one-shot `timer(0)` initial fetch or a reconnect back-off delay is not.
- List endpoints MUST return summaries (no headers/bodies); details are fetched only when opened.
- SQL MUST be windowed and indexed: name only the needed columns, never select bodies for list or
  range queries, and add a `LIMIT` as a seatbelt. A port default that filters `readAll()` MUST be
  overridden in the SQLite adapter before it is relied upon.
- Never materialize a whole store as one in-memory String or collection per request; stream
  (temp file + atomic move) or append instead. Any per-request allocation proportional to total
  stored data is a defect.
- Every store MUST have an explicit retention policy (row cap, size cap, or a documented reason
  it is unbounded, as session-cycle capture is).
- Performance claims in PRs and docs SHOULD cite a measurement (latency, CPU, memory, row count),
  matching how existing docs record them.

Rationale: past incidents (`/call-overlaps` GC spiral, inbound OOM dropping calls silently) were
all correct-on-small-data code that failed at production volume.

### III. Hexagonal Vertical Slices (NON-NEGOTIABLE)

The backend is one Maven module per feature, each hexagonal inside. New features and edits MUST
follow this shape — read `docs/architecture.md` before touching the backend.

- Package layout per slice: `domain.model` / `application.port.in|out` / `application.service` /
  `adapter.in.web` / `adapter.out.*`. Dependencies point inward only.
- Domain types are pure: no Spring (Jackson is allowed). Prefer Java `record`s.
- Inbound adapters (controllers, webhooks) call use-case ports only, never services or outbound
  adapters directly. Services depend on ports, never on adapters.
- Cross-slice edges are only those enforced by `HexagonalArchitectureTest`
  (`export→calls`, `session-cycles→calls`, `session-cycles→internal-calls`). A new edge requires
  a constitution-level justification in the plan and an updated ArchUnit rule. Slices that must
  cooperate meet through ports (e.g. `NewCallObserverPort`) or payloads, not shared code.
- Cross-slice logic that cannot live in either slice goes in `backend-app` (composition root).
- A new slice follows the "Adding a slice" checklist: module, aggregator `<modules>`,
  `backend-app` deps, `backend-architecture-test` deps plus an isolation rule.
- Persistence is chosen per slice with `@ConditionalOnProperty`; SQLite is the default, the file
  adapter stays working as an opt-out. Do not assume file-adapter caching behavior for SQLite.
- Reuse the domain record on the wire when the shape matches; add a `dto` only when the boundary
  needs something the domain must not carry.
- Frontend: standalone Angular components + signals, no NgModules/NgRx. Shared components are
  reused via DI tokens, not forked (see `docs/frontend-architecture.md`). Pure logic lives in
  `shared/utils` and is tested directly.
- Proxies persist nothing; backend is the sole system of record.

Rationale: module boundaries turn architectural drift into a compile error and ArchUnit catches
the rest. That only works if every change keeps the shape.

### IV. Match the Existing Code Style

New code MUST read like the code around it. Consistency beats personal preference.

- Java: constructor injection with `private final` fields (no field `@Autowired`); `record`s for
  domain and DTOs; one use-case interface per operation in `port.in`, implemented by the slice's
  service; `Optional` for absent lookups; explicit outcome enums for multi-result operations
  (e.g. delete → 404/204/409) rather than re-derived checks; SLF4J for logging.
- Naming follows the existing patterns: `*UseCase`, `*Port`, `*Service`, `*Controller`,
  `Sqlite*Adapter`/`Sqlite*Repository`, `File*Adapter`/`JsonFile*Adapter`, `*RequestDto`.
- TypeScript: `strict` and `strictTemplates` stay on; no `any` where a type exists; signals for
  state; `inject()` for DI; one concern per file in the existing `components/`, `pages/`,
  `core/{models,services,state}`, `shared/{components,utils}` layout.
- Python addons follow the structure of `proxy/log_and_route.py` / `log_and_route_reverse.py`.
- Comments explain WHY (constraints, past incidents, rejected alternatives) — the existing
  Javadoc density is the reference. Do not narrate what the code already says.
- Do not reformat, rename or restructure code outside the change's scope.

Rationale: a reader should not be able to tell which change a line came from.

### V. Clean, Maintainable Code

- Single responsibility: small, intention-revealing functions and classes. A method that needs a
  comment per block needs extracting.
- One implementation per behavior. Before writing logic, search for an existing one
  (`CallListSupport`, `layoutSpacers`, `CallSummary.supplierNameOf`, export narrative, etc.) and
  reuse it. Duplicated logic that must stay in sync is a defect.
- YAGNI: build only what the spec requires. No speculative options, flags or abstractions.
- No dead code, commented-out code, or unexplained magic numbers; name constants.
- Make illegal states unrepresentable where cheap (records, enums, validated DTOs).
- Errors are handled at the boundary that can act on them; never swallowed.
- Configuration is property-driven (`@Value` / env), with safe defaults documented alongside.

Rationale: this codebase is maintained by humans and agents together; clarity is what keeps both
from repeating past bugs.

### VI. Verified Changes

- Backend: application services are tested against fake/mocked ports; file adapters against a
  real `@TempDir`; controllers with thin `@WebMvcTest`; the ArchUnit suite MUST pass.
- Frontend: pure functions tested directly; component tests only when behavior exists only as a
  DOM/lifecycle/HTTP interaction.
- Every bug fix includes a test that fails without the fix.
- Tests MUST use realistic data where size matters (no-truncation guards use large bodies; import
  fixtures are built by `buildBulkExportPayload`, never by hand).
- `mvn test`, `npm test` and `npm run build` MUST pass before a change is considered done.

Rationale: several past bugs passed tests built on shapes production never produces.

## Architectural Invariants

These are fixed facts of the system; a change that breaks one needs an explicit amendment.

- Exports (.md/.json/.html/cURL) never truncate or summarize call data. The .json export is the
  re-import format; `import-parser.ts` stays the exact inverse of `bulk-json-builder.ts`.
- Interception rules are evaluated inside the mitmproxy addons against a backend-published
  snapshot, never in the backend on the request path.
- Session-cycle spacers anchor to the call above them; all placement goes through `layoutSpacers`.
- Callers stay on `localhost`; reverse-proxy routing is port-based, never hostname-based.
- Docker never touches the host; host changes happen only via `start.py`/`start.sh`/`start.ps1`.
- `settings.properties` only fills gaps in `.env`; it never overwrites an adopted value.
- A new backend route prefix is added to the `app-gateway` regex (`gateway/nginx.conf`).

## Development Workflow & Quality Gates

- Plan before implementing: every feature starts with a spec and plan (and a UI mock for UI
  changes) that passes the Constitution Check, approved before code is written.
- The plan's Constitution Check MUST explicitly answer: security impact, performance impact at
  real scale, slice placement and cross-slice edges, reuse of existing logic, and test strategy.
- Any violation MUST be recorded in the plan's Complexity Tracking table with the simpler
  alternative that was rejected and why.
- Reviews check the principles above in order: security, performance, architecture, style,
  cleanliness, tests.
- Docs are part of the change: if behavior documented in `CLAUDE.md`, `AGENTS.md` or `docs/*.md`
  changes, the doc is updated in the same change.

## Governance

- This constitution supersedes conflicting practice. `CLAUDE.md`, `AGENTS.md` and `docs/*.md`
  hold the detailed runtime guidance and MUST stay consistent with it.
- Amendments: propose the change with rationale, update this file and its Sync Impact Report,
  propagate to `.specify/templates/*`, and bump the version:
  MAJOR for removed or redefined principles, MINOR for new principles or materially expanded
  guidance, PATCH for clarifications and wording.
- Compliance: every plan runs the Constitution Check gate before research and again after design;
  every review verifies compliance. Unjustified complexity is rejected.

**Version**: 1.0.0 | **Ratified**: 2026-09-23 | **Last Amended**: 2026-09-23
