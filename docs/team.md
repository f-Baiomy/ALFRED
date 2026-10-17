# Team tab (team trackers)

The Team tab (specs/027, rebuilt by specs/028) searches the team's tracker **live** and puts what matters on Alfred
boards: a board's main work item and its tree, the items its cards are about, what arrives from the tracker, and the
updates the user approves for it. Azure DevOps is the first tracker; Jira and ClickUp are listed as "not installed"
until their connectors exist.

Nothing found by a search is stored. Alfred keeps only the filter lists, and for a board its items (a full copy of the
main and of each card's item, references for the rest).

## Where it lives

- **Backend**: the `backend-teamboards` family:
  - `teamboards-spi` - the connector interface, Spring-free. `Connector` (kind, words, one item, types, people) plus
    optional capabilities, each an interface a connector implements (`instanceof`, never declared): reads -
    `ItemSearcher`, `QueryRunner`, `ItemReader` (items in batches of 200, comments), `TreeReader`, `IdentityReader`
    (who owns the token, people by id), `StateCatalog` (states with their categories, areas), `AttachmentsReader`,
    `HookReader` (the ids a service-hook ping names); writes - `ItemWriter` (comment, state, create, hyperlink, tag)
    and `AttachmentWriter`. ArchUnit: the SPI has no Spring, write methods live only in the writer interfaces, and only
    the consent-bundle service calls them.
  - `teamboards-core` - `teamboards.db` (schema 2), `/teamboards/**` REST, the `/ws/teamboards` signal. Services:
    `TokenVault` + `Live` (the token and every live call), `TeamService` (connections, lists, mappings, me),
    `TeamSearchService`, `BoardItemsService` (main item, tree, sync), `CardItemsService` (card links),
    `IncomingService`, `WatchRulesService`, `HookService`, `AzureWritesService` (consent bundles - the only caller of
    the writers), `PeopleService`, `StartService`, `SeedBuilder`, `TeamTransferService` (export/import),
    `TeamRetention` (every 6 h).
  - `teamboards-azure` - `AzureDevOpsConnector`, `AzureClient` (JDK HttpClient, Basic auth with the PAT, 60 s timeout,
    one short `Retry-After` retry, no redirects followed with the token), `AzureMapper`, `AzureWiql`.
- **Bridge**: `backend-app/teamboardsbridge` - `TeamBoardsAdapter` (the board slice for the Team slice: cards, chat,
  similar cards, proposals, owners), `LinkedWorkItemAdapter` (the board's main for the Task tab; card status changes
  heard by the Team slice), `TeamRecordsImportAdapter` (a board import's team records), `TeamTokenLogFilter` and
  `TeamTunnelGuard`.
- **Frontend**: `pages/team` (Search, Mine, Teams, Iterations & boards) and `components/team/*` - connection switcher
  (token form, owner, time left, Forget), search form, results table (Add ▾), item drawer, person pill, board picker,
  related items, incoming lane, watch rules, card items ("Linked in Azure"), card owner, consent bundle, hook settings,
  start button, connection settings. `core/team/*` - models, API, state, `azure-export.ts` (evidence files) and
  `azure-evidence.service.ts`. A connector's UI lives only in `components/team/connectors/<kind>/`, provided once
  through `TEAM_CONNECTORS` in `app.config.ts`; `scripts/check-team-boundaries.mjs` enforces it.
- **MCP**: `mcp-server/src/tools/team.ts` (see docs/mcp.md "Team tracker"), and the `/alfred-team` skill.

## The token

The user enters a personal access token once on the Team tab (`PUT /teamboards/connections/{id}/token`, in the body).
Alfred checks it (`whoAmI` names its owner - "me") and keeps it **8 hours in memory only** (`TokenVault`): never on
disk, in a log, in a response or in a browser; a restart or **Forget** drops it, and a token the tracker refuses is
dropped at once. Everyone using this Alfred reads the tracker with the last token entered. Claude never holds a token:
with none live its tools answer `TOKEN_MISSING` and tell it to ask the user to enter one. Through the Cloudflare tunnel
no live read is served (`TeamTunnelGuard`) - a tunnel viewer cannot read the tracker with the owner's token.
Tests: `TeamServicesTest.theTokenIsNeverWrittenToTheDatabase` (no file, status, search, bundle or vault text holds it),
`TokenVaultTest`, `TeamTokenNeverStoredTest`.

## Search

`POST /teamboards/connections/{id}/search`: text plus filters - types, states, Open only (default on: states whose
category is not Completed or Removed, read from the process), areas, teams (`Project\Team`, by the team's own area
paths), iterations (or `@current`: each picked team's current sprint), assigned (unique names, `me`, `none` for
unassigned), created by (unique names, `me`), changed within, tags, parent ids, and Mine (assigned, created, changed,
mentioned, followed - OR'ed). Since specs/029 every filter takes several values: inside a filter they are OR'ed, filters
are AND'ed; `areaExact` makes an area match only itself (default: with its sub-areas, WIQL `UNDER`), `tagsAll` asks for
every tag (default: any). `assigned`, `createdBy` and `parents` also accept a single value, and `parent` is read as
`parents`, so watch rules saved before keep working. The Team tab picks each filter with the shared
`app-multi-select-picker` (compact, typed values for ids and tags) and shows a chip per filter in use. Azure's Search API (`almsearch.dev.azure.com`) does
full-text; where the organisation has none (404) the connection falls back to WIQL title matching and the answer says
`fullText: false`. 50 a page; each row carries where it already sits in Alfred (main of board X, on card #n, related)
and whether the tracker moved past Alfred's copy. `POST .../query` runs a WIQL SELECT (≤ 200). Every WIQL value is
quoted.

**Show** (`show`: `ITEMS` default, `PARENTS`, `TREE`; `childDepth` 1 or 0 for every level): with PARENTS each match of
the page is read with its parent chain up to the top, with TREE also its children - level by level from the items'
relations, one batch per level, never stored. They come back as `context` (rows with `parent`), at most 500 a page
(`contextLeftOut` counts the rest); the table draws the tree (matches bold, context dimmed and tagged parent/child,
branches fold) and `team_search` answers it as indented lines. The choice is remembered per browser.

**Saved searches** (`GET/POST .../connections/{id}/saved`, `PATCH/DELETE /teamboards/saved/{sid}`, `POST .../saved/{sid}/move`;
`saved_searches` in teamboards.db, per connection, at most 50): a search - text, every filter with its modes, Open only,
sort and Show, always page 1 - kept under a unique name and shown as a pill above the results. One click fills the form
and runs it (the search names it as `saved`, so the pill keeps the last count); ⋯ edits (the pill turns dashed amber,
*Save changes* / *Save as new*), renames, moves left/right or deletes it. A search changed after its pill ran shows a dot
and *Save changes*. "The same search" is `searchKey` (values in any order; page, Show and the id do not count). Every
browser sees the same pills, read again on the `saved` signal. Only the user saves, changes, moves or deletes one;
Claude lists them (`team_saved`) and runs one (`team_search saved: "<name>"`, a filter given beside it replacing that
filter). While a search reads Azure for more than 150 ms the table shows eight skeleton rows in its own shape (indented
in tree mode), still with "reduce motion".

**Lists** (`GET .../lists`): types, states with categories, areas, teams with members, iterations, people, tags, the
tracker's boards - read in the background when the tab opens and they are older than 10 minutes (or on ↻ Refresh
lists). They feed the filters, the person pills (a person is named, never a raw id) and the browsers - a team, a member
or an iteration clicked runs a search.

**An item** (`GET .../items/{id}?include=comments,history,attachments`) is read live with every field, its links and
where it sits in Alfred; for an item Alfred keeps, the diff against the copy. From the drawer the user's own state move
or comment goes to the tracker at once (`PATCH`, with the "via Alfred" footer) and is recorded as a done bundle; the
same call from Claude creates a waiting bundle.

## A board's items

`/teamboards/boards/{board}/items`: the first item added is the board's **main** (one per board, `ux_board_main`);
adding it reads its **tree** - ancestors, descendants, one hop of other links - as references. More than 200 related
items asks first (up to 1000). Make main re-roots the tree and keeps a copy of the new main. The main and every item on
a card are **full copies**; the rest are references read live. **Sync** (on opening Related items, at most once a
minute, or Refresh all) re-reads the copies and the tree: each change field by field into `item_syncs` (shown as
"● changed" until the user keeps the new copy), new descendants offered in Incoming, items gone from the tree marked
"left the tree", and an item closed or reopened in the tracker gives its cards a move proposal.

The board's **Related items** tab shows Tree / By type, the Kept column, Add by id or URL, Incoming and watch rules.
The Task tab's chip shows the main and its changes (Save to brief / Dismiss keep the new copy).

## Cards and items

A card links to any number of items and an item to any number of cards (`/teamboards/cards/{card}/items`). Linking
saves the item's copy, writes a "Linked in Azure" pill into the card and makes it a CARD item of the board. The markers
in the tracker (a hyperlink back to Alfred, a comment, a tag) are always a bundle the user approves. Create in Azure
from a card prepares the new item as a bundle; once approved it is linked to the card. Unlinking (the user's only)
offers a cleanup bundle. "Also post to <item>" sends the user's own card comment to each linked item.

## Refresh from Azure (specs/030)

"↻ Refresh from Azure" on a board with a main item (the stage strip, `POST /teamboards/boards/{board}/sync` with
`{"force": true, "wait": true}`) syncs now and answers with what it found, with no Claude run: `newItems` (new in the
main's tree - they still go to Incoming), `changedItems` (copies Azure moved past: the fields that differ and
`newComments`), `mainState` (the main's state before → after with its category, and its iteration move) and `matches`
(proposed card matches after this sync). Without `wait` the sync runs in the background as before and its counts
arrive on `/ws/teamboards` (what `sync`, now with `matches` and `mainState`). A main Closed, Removed or moved out of
its iteration shows a banner; `/alfred-setup <board>` re-run proposes closing the open cards - the user decides.
MCP: `team_refresh_item` with `board` (a board ref) prints the same result.

## Card matches and the card's Azure panel (specs/030)

A card with no Azure item gets **matches** found by code (`MatchService`, table `item_matches` in `teamboards.db`, run
at the end of every sync): open Bug / Task / Issue items of the board's tree that no card of the board links, not made
before the card (`System.CreatedDate`), scored by the share of words the two texts have in common (stop words, tags and
numbers out) plus 0.5 for each `/api/...` path both name (numbers and `{x}` segments read as `{id}`). A match needs two
shared words and 0.3, or a shared path; at most five per card. The item's text is what the sync read live, else its
copy, else its title. A `REJECTED` ("Not this one") or `LINKED` row is never proposed again; a proposal whose card or
item no longer qualifies goes. Claude writes its reason with `team_card_matches` (`why`) - it survives re-scoring.

`GET /teamboards/cards/{card}/matches`, `POST …/matches/{conn}/{item}/link` (the user's own link, no bundle; the item
leaves every other card's proposals), `POST …/reject` (user only), `PUT …/why`. Only REJECTED rows travel in the board
export, as `team-card-match` records by card number, so an imported board never proposes them again.

The card drawer's **Linked in Azure** shows, for a card with no item, the best match with its reason (Link / Not this
one / Show others), then "+ create in Azure" - a bundle that creates the item **under the board's main item** (a
`System.LinkTypes.Hierarchy-Reverse` relation; `NewItem.parent`) and links it once approved. For a linked item,
**Azure ▾** offers the user's own comment and state (sent at once with their token, like the item drawer) and **Draft
with Claude**, which posts `/alfred-team update card #<n>` to the board's chat; the draft comes back as a bundle.

As Claude, `team_link_card` with an `askedIn` naming the user's request links in Alfred at once (the cards
`/alfred-setup` drafts from a work item's children, on the user's "Save all"); without it the link is a bundle step.
Tracker markers are always a bundle.

## Incoming, watch rules, the service hook

**Incoming** (per board): items that arrived - new in the main's tree (TREE), a watch rule (RULE), the hook (HOOK), by
hand (HAND), from Claude (MCP) - each offered once, with its closest card ("Looks like …", similarity ≥ 40) and any
proposal of Claude's. The user makes a New card (kind from the type → kind map; Epics and Features stay related items),
Links it to a card, or Ignores it until it changes.

**Watch rules**: a board's saved searches, run when the board opens, on Refresh, on a hook ping and from Claude; each
new match lands once in Incoming (200 matches a run at most).

**Service hook**: `POST /teamboards/hooks/azure` - the one write reachable through the tunnel (`BoardWebConfig`
excludes it from the edit rule). Basic auth whose password is the secret (stored as PBKDF2, 120k iterations, checked in
constant time; a route rate limit runs before any hashing). A ping names ids only; with a token live Alfred reads them
and routes them to the boards whose tree or rules they match, else it keeps the ids (`hook_waiting`, 7 days) and drains
them when a token is entered. Settings → Team trackers → Hook & kinds shows the URL, makes the secret (shown once),
keeps Alfred's public address (for the links written into the tracker) and the type → card kind map.

## Telling the tracker: consent bundles

Nothing is written to the tracker without the user's approval, except the user's own direct state change or comment.
Every other write - Claude's comments and state moves, card markers, created items, Tell Azure on Verified / Done
(origin ALFRED), cleanups - is a **bundle** (`/teamboards/writes`): steps in order, each tickable and editable, an
ATTACH step's file built in the user's browser from Alfred's own HTML export with the user's redactions and the
always-masked credential headers (`ALWAYS_MASKED_HEADERS`) unless that file is ticked "send unmasked". Approve sends the
ticked steps with the vault's token (waits with none) and records each step's result (DONE or PARTIAL); only the user
approves. Comments end with "via Alfred: board …" and a link when the public address is set. Files are deleted when a
bundle ends.

## People and "me"

A person is a pill: name, "me" marked, a hover card (email, teams, open items assigned, Alfred cards they own or are
mentioned on). "Me" is the token's owner, or the person picked as "This is me" until the token changes hands. Board text
mentions a person as `@[person:<conn>/<id>|Name]` (the @ picker has a People tab). A card has one owner,
`<conn>/<person id>|<name>`, kept in the board slice next to the card (Claude sets it only on its own Inbox cards).
**Mine** lists what is the user's: assigned, created, changed, mentioning, followed in the tracker, plus the boards of
their items and the cards they own or are mentioned on.

## Start: a board from a work item

Unchanged from specs/027 in shape: the item's mapping (sprint, squad, area, project) or the user's pick says where; one
start per item; a waiting `/alfred-setup <conn>/<id>` message is posted as the user to the target board's chat. Since
028 the Start needs no token in the request (the vault's is used for the attachments), and `team_link` makes the item
the board's **main**, so the seed (`GET /teamboards/items/{conn}/{id}/seed`, from the copy or live) and the changes
come from it.

**New board from this item** (specs/029; Add to board ▾ in the item drawer, Add ▾ in the results; `POST
/teamboards/items/{conn}/{id}/board`; MCP `team_new_board`, which needs `askedIn` like `team_start`) makes the board at
once, with no Claude and nothing written to the tracker: the name defaults to `#<id>_<title>` cut at a word to 120
characters (a name an open board of the project already has is a 409), the item becomes its main with its tree as
related items (or a related item, with a note, when it is another board's main already), and its first cycle is
`NEW` (made, then paused before it joins the board, so it records nothing), `RECORD` (records now; the project's
running recording pauses) or `NONE`. The item is read live first, so an unknown item makes nothing, and a failure to
link it deletes the board just made. ▶ Start stays the way to have Claude set a board up.

**The seed in full** (specs/030): besides purpose, steps, acceptance, context and the parent's acceptance, the seed
holds `childItems` - every child in full (its fields by the field maps, repro, acceptance, state and category, `done`
when Completed/Removed, its comments, its own children as title lines) - `parents`, the chain up to the top (cap 6,
loop-guarded; each one's description and acceptance), and the item's comments. The old one-line `children` list stays
for older clients. MCP `team_item` (`seed: true`) pages each long part with `part` + `offset` (`children`, `parents`,
`comments`), never cut; `/alfred-setup` turns them into the brief, spec and cards (skills rules §0a).

## Export and import

A board's JSON export carries its tracker side (`GET /teamboards/boards/{board}/export`): `team-item` (with full
copies, never cut), `team-card-link` (by card number), `team-incoming` (waiting ones), `team-watch-rule`, and
`card-owner`. Import writes them onto the board's and cards' ids here; a record naming a connection this Alfred does not
have is skipped; a 027 `workitem-snapshot` becomes the board's main.

## Upgrade from 027

Schema 2 drops the 027 cache (items, fields, full-text index, revisions, links, changes, board links) - nothing is
migrated - and the Team tab shows a one-time notice. Connections, mappings, field maps and people stay.

## Retention

`TeamRetention` every 6 hours: 50 syncs per item, decided Incoming 90 days, ended bundles 180 days (their files with
them), hook ids 7 days, fetched attachments 24 hours. Settings → Storage lists `teamboards.db`.

## REST

See `specs/028-team-live-search/contracts/teamboards-rest.md`. Writes follow the board's edit rule (`BoardWebConfig`
covers `/teamboards/**`, except the hook); live reads are refused through the tunnel.
