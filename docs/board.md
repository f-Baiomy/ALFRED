# Task board

The board (specs/014-task-board) tracks bugs, tasks, notes and questions next to the traffic they are about. There is one board per project, and each session cycle has a view of its own cards. Claude adds findings to it through the MCP tools. The user sorts them, and the history of every card records what was done.

## Where it lives

- **Backend**: the leaf slice `backend-board`, with its own `board.db` (`BOARD_DB_FILE`, default `/appdata/board.db`; `board.db` in the native data folder). It exposes REST under `/board` and the `/ws/board` signal. SQLite only: the slice is new, so there is no flat file to migrate (the same reasoning as `backend-triage`).
- **Bridge**: `backend-app/boardbridge` holds everything that touches other slices:
  - `BoardEditAccess` and its interceptor apply the edit rule.
  - `BoardCallSignatureAdapter` builds signatures from `CallRefResolver` and triage's `NormalizeEndpointUseCase`.
  - `BoardCycleRemovedAdapter` implements session-cycles' `CycleRemovedPort`.
  - Kept calls go through `storage/CommentedCallsKept`: its `BoardMentions` component implements the board's `MentionedCallsChangedPort`.
- **Frontend**:
  - The Board tab (`/board?project=&cycle=&card=`) and the session cycle page's Calls / Board / Brief & specs tabs both use one `BoardViewComponent`. Each view gets its own `BoardStateService`.
  - Every call card (`call-actions`) shows the cards that mention the call and a **＋ Board** button.
  - There is one `SpecViewerComponent` in the main layout.
- **MCP**: `mcp-server/src/tools/board.ts` provides `board_list`, `board_get`, `board_add`, `board_comment`, `board_move`, `board_flag`, `board_closed_reasons`, `get_brief`, `read_spec` and `board_status`.

## Cards

- **Kind**: Bug, Task, Note, Question.
- **Flags**: Urgent, Risk, Blocker, Affects project, Needs decision.
- **Scope**: Not decided, In scope, Out of scope. Only the user sets scope.
- **Status columns**: Inbox, To do, In progress, Fixed, Verified, Done, Closed.
  - Closed always carries a resolution:
    - **Fine - not an issue**
    - **Not in this flow** (this also sets Out of scope)
    - **Won't fix**
  - Buttons show the short labels ("✓ Fine", "⊘ Not in flow"); chips and exports show the full names.
- **Numbers** are unique per project and never reused. `card_numbers` remembers the highest number ever given, so a deleted card's number stays retired.
- **Concurrent edits**: a PATCH carries only the fields it changes, and each changed field writes one activity entry. Two tabs editing different fields both win; for the same field, the later edit wins. There is no version check.
- **Done and Closed cards are kept forever.** Only the user deletes a card, after a confirmation. A deleted card takes its history and mention rows with it.
- **Undo** (`POST /board/cards/{id}/undo-close`): the toast offers it for 7 s, and the server allows it for 60 s. It restores the state recorded in the close's own RESOLUTION entry, and only while nothing but a reason was added after the close.

## Mentions

`@[type:ref|label]` inside Markdown text. The grammar is in `specs/014-task-board/contracts/mention-syntax.md`; the vectors in `specs/014-task-board/vectors/mentions.json` are run by both `MentionParser.java` and `mention-syntax.ts`.

Types: `call` (`in:<id>` / `out:<id>`, plus `@<cycleId>` for a captured call), `stmt` (`<callId>/<seq>`), `log` (`<callId>/<lineId>`), `redis` (`<callId>/<seq>`), `spec` (`<cycleId>/<file>#<section-slug>`), `code` (`path:line`), `cycle`, `spacer` (`<cycleId>/<spacerId>`), `card` (`<project>#<n>`), `rule`.

- **The text is the source of truth.** On every save, the backend re-extracts the mentions of that owner (card description, comment, brief, or checklist evidence) into the `mentions` index. That index feeds the Linked list, the card badges on calls, and kept calls. Links added with "+ link" are stored as owner `DIRECT`.
- **Kept calls**: a live call that any card mentions is kept out of the storage limits' deletions, like a call with a comment. This is governed by the same Settings → Storage rule. The board reports changes, so a newly mentioned call is kept at once rather than after the 30 s cache expires. Captured cycle calls are already kept with their cycle.
- **Removed items**: a mention whose item is gone shows struck through with its saved label. The text around it is untouched.
- **Rendering**: `markdown-blocks.ts` builds a typed tree that `MarkdownViewComponent` renders with bindings, never `innerHTML`. Links are kept only for `http(s)` URLs.

## Inbox sorting

- Each Inbox card has one-click **Fine / Not in flow / To do**, also on the F, N and T keys.
- **Triage mode** shows the Inbox one card at a time, with a reason box and F / N / T / S.
- **Bulk actions** apply to the selected cards (X or Shift+click), up to 200 per request.
- **Reopen** sends a closed card back to the Inbox.
- **"Looks like a closed card"**: when the first call a card mentions gives a signature (`<5xx|4xx|error|ok>|<METHOD> <endpoint pattern>`, using triage's endpoint grouping) that matches a closed card in the same project, the Inbox card shows that card and its reason.

## Cycle brief, spec files, checklist

- **Brief**: Markdown with mentions, up to 256 KB.
- **Spec files**: `.md` / `.txt` only, by upload, drop or paste. Up to 5 MB each and 50 per cycle. A file with the same name replaces the old one; there are no versions. Every card that mentions a replaced file gets a "spec replaced" entry.
- **Acceptance checklist**: the list items under a spec file's first heading that contains "acceptance". The user marks each one pass, fail or can't tell, with evidence. A mark is keyed by the SHA-256 of the item's normalized text, so it survives a replace that leaves the item unchanged. Claude never marks an item; it **suggests** a mark with evidence (`checklist_suggestions`, `PUT .../checklist/{file}/{item}/suggestion`). The suggestion shows grey under the item with Accept and dismiss. Accepting writes the user's own mark with Claude's evidence. Any mark the user sets clears the suggestion.
- **Deleting a cycle** removes its brief, spec files and marks. Its cards stay on the project board, marked "cycle deleted".

## Claude's limits

These are enforced in `BoardService` and `CycleBriefService` whenever `X-Alfred-Actor: claude` is sent. The MCP tools send it on every board request.

- New cards always land in the Inbox.
- Claude may move cards only to To do, In progress or Fixed, and never out of Verified, Done or Closed.
- Claude may not set scope, close, reopen, delete, bulk-edit, undo, set a reason, mark the checklist, or write briefs and spec files.
- A Claude comment must give Did, Found and Next; Impact is optional. The two other kinds are a **reply** (`**Reply** ...`, an answer to the user) and a **question** (`**Question** ...`). A question also flags the card Needs decision. Other free text is refused.
- Claude may rewrite the title, description, kind, cycle or project only of **its own** cards, and only while they are in the Inbox. It may set flags on any card.
- Verified, Done and closing stay the user's. Claude **proposes** them instead (`proposals` table, one open per card, `PUT /board/cards/{id}/proposal`). Allowed proposals: Verified for a Fixed card, Done for a Fixed or Verified card, and a close with its resolution for an open card. The card and the drawer show "✦ Claude proposes ..." with Accept and Dismiss. Accepting takes the step as the user's own move or close. If the card changed so the step no longer fits, accepting drops the proposal instead. The history records PROPOSED, PROPOSAL_ACCEPTED and PROPOSAL_DISMISSED.
- While the live strip is **paused**, Claude's new cards are refused. A card whose call links match a card closed as Fine or Not in this flow is refused with that card's number and reason; Won't fix does not block.
- These are guardrails against an agent overreaching, not a security boundary: anyone with edit access can do what the UI does.

The live strip status is held in memory per project. It reads as STOPPED when it has not been updated for 10 minutes. The backend computes that on read; the frontend arms a single timer to the deadline, which the no-polling rule allows.

## Claude working from anywhere

Read-only endpoints in `BoardInsightsService` / `BoardInsightsController` let a new session pick the work up without the user repeating it:

- `GET /board/search`: cards on every board when `project` is omitted, filtered by status, kind, flag, author, text, `since` and `claudeTouched`. Each card comes with its latest comment, in full.
- `GET /board/similar`: cards in any status with the same signature as a call, or with at least two title words in common. Claude reads these before adding a card.
- `GET /board/changes?cursor=`: every history entry after the cursor with its card, plus the briefs, spec files, marks and suggestions written in cycles. The cursor is `<activityId>.<millis>`. Two special cursors exist: `now`, and `claude`, which means just after Claude's own last entry. `actor=USER` keeps only what the user did.
- `GET /board/changes/wait`: the same answer as soon as anything changes, or an empty one after `timeoutSeconds` (at most 50, under the gateway's 60 s read timeout). It is a `DeferredResult` woken by `BoardChangeFeed`, which fires with every /ws/board signal. There is no polling. The waiter subscribes before it reads, so a change in between is not missed.
- `GET /board/verify?project=&cycleId=`: each Fixed card's signature compared with the calls a re-test cycle captured to the same endpoint. The calls are signed by `boardbridge/BoardCycleCallsAdapter` the same way as a card's call. The verdict is LOOKS_FIXED (every call is ok now), STILL_FAILING or NOT_EXERCISED.
- Call badges now carry the card title, so `board_for_call` can say which card a call is on.

The MCP tools built on these are listed in docs/mcp.md: `board_search`, `board_changes`, `board_wait`, `board_get`, `board_evidence`, `board_for_call`, `board_similar`, `board_verify`, `board_reply`, `board_ask`, `board_fix`, `board_edit`, `board_link`, `board_add_many`, `board_propose` and `board_suggest_mark`. `board_get` returns every comment in full. A comment over 6000 characters is read in parts with `entry`, and the history is paged with `historyOffset`. Nothing is cut silently.

## Edit access

Board writes follow the server-settings rule (`EditAccessUseCase`), with one exception: Docker, which refuses every settings write, lets board edits through, because cards are data, not settings. The Cloudflare tunnel is always view-only. `GET /board/access` returns the same decision to the page, which then hides its edit controls and shows "View only". Export stays available.

## Export and import

- **Board export**: Board → .md, .html or .json, either the whole board or the selected cards.
- **`alfred-board/1`** (`board-json.ts`): a header line, then one record per line: card (fields plus direct links), activity (by card number), brief, spec (in full) and mark. Nothing is shortened. `POST /board/import?project=` streams it in. A clashing number gets the next free one, and `@[card:...]` mentions of moved cards are rewritten to match.
- **The HTML export** escapes every value.
- **Cycle export**: "Include brief & specs" and "Include board cards" are both off by default, and with both off the output is identical to before (guarded in `export-build.spec.ts`). When ticked, they append the board to the .md / .html report. With .json, the calls file stays the calls re-import format, and the board is written beside it as its own alfred-board file.

## Limits and measurements

**Seatbelts** (clamped server-side):

| Item | Limit |
|---|---|
| Title | 300 chars |
| Description, comment, brief | 256 KB each |
| Reason | 2,000 chars |
| Evidence | 8 KB |
| Bulk request | 200 cards |
| List page | 500 cards |
| Activity page | 1,000 entries |
| Badge request | 100 call ids |
| Import file | 200 MB |

**Retention**: kept until the user deletes it. A board is manual data, measured in KB.

**Measured performance** (`SqliteBoardRepositoryPerfTest`, Docker JDK 21, a temp folder): 2,000 cards, each with a 4 KB description, 5 history entries and 2 mentions.

- Opening the board (first 500 rows, with comment counts, chips, total and progress): **43 ms**.
- A filtered list (kind + flag + search): **4 ms**.

This is SC-005's "open and filter in under a second" with plenty of room. The list query never selects descriptions.

On the running Docker stack (2026-10-10 quickstart walk-through), a change made in one tab reached another tab's `/ws/board` listener in **22 ms**, and its re-fetch of the board took **6 ms** (SC-004: under 2 s).
