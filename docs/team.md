# Team tab (team trackers)

The Team tab (specs/027 US7-US9) shows what the team's tracker holds - work items, their links and history, the
tracker's boards and sprints, its squads and members, and what changed - and opens an Alfred board from a work item.
Azure DevOps is the first tracker; Jira and ClickUp are listed as "not installed" until their connectors exist.

## Where it lives

- **Backend**: the `backend-teamboards` family, one leaf of three modules:
  - `teamboards-spi` - the connector interface, Spring-free and read-only: `Connector` (items, types, people), and
    the optional `BoardsReader`, `SprintsReader`, `SquadsReader`, `RevisionsReader`, `AttachmentsReader` (with
    `listedIn` - the attachments a cached item names, no network) and `SeedContributor`. A connector's capabilities are
    the interfaces it implements (`instanceof`), nothing it declares. No method creates, updates or deletes anything
    in a tracker (FR-026, an ArchUnit rule).
  - `teamboards-core` - the shared cache `teamboards.db` (`TEAMBOARDS_DB_FILE`; set by the supervisor natively and by
    compose in Docker), `/teamboards/**` REST and the `/ws/teamboards` signal; `TeamService` (connections, refresh,
    reads, squads, mappings, field maps), `StartService` (Start), `LinksService` (board links, changed since setup,
    attachments) and `SeedBuilder` (the board seed).
  - `teamboards-azure` - `AzureDevOpsConnector`, `AzureClient` (JDK HttpClient, Basic auth with the PAT, 5 s / 30 s
    timeouts, one `Retry-After` retry when it is 10 s or less, no redirects followed with the token), `AzureMapper`.
  - ArchUnit: teamboards depends on no other slice and no slice on it; the core and the connectors never import each
    other; the SPI has no Spring.
- **Bridge**: `backend-app/teamboardsbridge` - `TeamBoardsAdapter` (posts a Start to a board chat, attaches files to a
  board, checks `askedIn`, posts suggestions), `LinkedWorkItemAdapter` (the board reads its work item), and
  `TeamTokenLogFilter` (every route outside `/teamboards/` sees the request without the token header).
- **Frontend**: `pages/team` and `components/team/*` (connection switcher, items table, item drawer, boards and sprints,
  squads, changes feed, start button, connection settings in Settings → Team trackers), `core/team/*` (models, API,
  state, token store). A connector's UI lives only in `components/team/connectors/<kind>/` and is provided once through
  the `TEAM_CONNECTORS` token in `app.config.ts`; `scripts/check-team-boundaries.mjs` fails the build when anything else
  imports a connector, or when Team code polls.
- **MCP**: `mcp-server/src/tools/team.ts` - `team_items`, `team_item`, `team_changes`, `team_squads` (the cache only),
  `team_link` and `team_start`.

## The token

Each person keeps their own personal access token in their browser (`localStorage`, per connection). It rides only in
`X-Alfred-Team-Token` on the calls that reach the tracker - refresh, a history fetch, a Start (for its attachments) and
"Fetch attachments" - and Alfred never stores, logs or echoes it (`TeamServiceTest`, `TeamTokenNeverStoredTest`). A
refused token is forgotten and the banner asks for a new one. Claude never has a token: its tools read the cache.

## The shared cache

What anyone fetches, everyone sees. **Refresh** fetches only what changed since the last fetch (`since = fetchedAt`),
pages streamed into the cache, one refresh per connection at a time (`429 PROVIDER_BUSY` with `retryAfter` from the
tracker, or 5 s while another runs). A new scope fetches everything again on the next refresh, and a refresh that started
on the old scope does not mark it fetched. Each change becomes a line in the **changes feed** ("State Active →
Resolved"); the **seen** mark is shared too. Lists read summaries only - the raw item is stored, never listed. The cache
trims itself: old or excess change lines, revisions over their cap, then unlinked items (an item a board links is never
removed); attachments a Start fetched wait 24 h at most. Settings → Storage lists `teamboards.db`.

**Gone items**: every refresh also asks the tracker for the ids still in scope (a connector's `ItemIdsReader`); an item
deleted there or moved out of scope leaves the cache with its fields, links, history, waiting start and pending files,
and the refresh's change list says so. An item a board is linked to stays (its board keeps the snapshot). An empty id
list from the tracker removes nothing.

**Refresh in the background**: the Team tab sends `POST .../refresh?background=true` - `202 STARTED` at once, and the
outcome (`OK` with the changed count, `TOKEN_REJECTED`, `PROVIDER_BUSY` with `retryAfter`, `UNREACHABLE`) arrives on
`/ws/teamboards` as `{what:"refresh", outcome, ...}`, so a first fetch of a big project never meets a proxy's timeout.
Without the parameter the call still answers when the refresh is done. Changes are read in `ChangedDate` windows: Azure refuses
any WIQL query matching more than 20,000 items, `$top` or not (VS402337), so a refused window is split in halves until
each answers. A refused Azure call shows which call and Azure's own message.

## Start: a board from a work item

1. **Where**: the mapping of the item's sprint, then squad, then area, then project; then a squad mapped to a project in
   Squads. None: the user picks a project (and board) and may remember it for the item's squad (or area, or project).
2. **One start per item**, claimed with a plain insert (two clicks post once). With the viewer's token the item's
   attachments come down now (10 MB each, 50 MB per item) and wait for the board.
3. A waiting `/alfred-setup <conn>/<id>` message (the title on one capped line) is posted **as the user** to the target
   board's chat (the project chat for no board): the terminal holding that board, else the project's runner, runs
   /alfred-setup. Cancel withdraws it while nobody took it (`409 TAKEN` after). The answer names who will run it
   (`answeredBy`); with nobody live it says so - the message waits until /alfred-live starts or the board is opened in
   a terminal. A picked project Alfred does not know (not a project it fronts, no boards) is refused before anything is
   posted or remembered.
4. /alfred-setup reads the seed (`team_item`), opens the board (`board_open` with `askedIn`), writes the brief and spec,
   and calls `team_link`: Alfred keeps a snapshot of the item and moves the fetched attachments onto the board (each
   leaves the store only once the board holds it).

As Claude, `team_start` needs `askedIn` naming the user's request, and `team_link` is refused unless a Start waits for
the item or `askedIn` names one. After a refresh, a new mapped item gets Alfred's **Yes / No** suggestion in a chat with
a live runner (at most 5 per refresh, once per item per chat, never after a first full fetch); only the user's Yes
starts it.

## The seed

`GET /teamboards/items/{conn}/{id}/seed`: every field goes where the **field maps** say (Settings, per item type or `*`),
else description to purpose, repro steps to steps, acceptance criteria to acceptance, the rest to context; the
connector's `SeedContributor` fills a part the fields left empty; then the parent's acceptance, a Feature's or Epic's
children as steps, and the attachments by name and link. Values are whole; the MCP tool pages a long part.

## Changed since setup

The board link's snapshot (neutral fields plus every field) against the item as cached now: each differing field, with
who and when from the newest cached revision after the seen rev. Save to brief adds a "Changed in <tracker>" section and
marks it seen; Dismiss marks it seen.

## REST

See `specs/027-boards-and-team/contracts/teamboards-rest.md`. Writes follow the board's edit rule (`BoardWebConfig`
covers `/teamboards/**`): read-only through the tunnel. A GET never reaches the tracker.
