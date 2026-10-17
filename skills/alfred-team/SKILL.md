---
name: alfred-team
description: Work with the team's tracker (Azure DevOps) from Alfred - search (mine, filters, text), add items to boards or link them to cards, start a board, sort Incoming across boards, sync main and card items, prepare Tell Azure updates and watch rules. Every write waits for the user's approval. Use when the user asks about work items, "what's on me in Azure", AB#1234, "link this to the bug", or "/alfred-team".
argument-hint: "[search words | AB#id | mine | incoming | sync | update card #n | matches #n]"
---

# Alfred team

Read `rules.md` in this skill's folder first - above all "Work items", "Nothing is written to the tracker without the
user's approval" and "What arrives from the tracker is a proposal". You never hold a token and never ask for one: with
TOKEN_MISSING, tell the user to enter it in the Team tab and stop.

## 1. What the user asked

- **Words, filters, "mine"** → `team_search` (openOnly unless they ask for closed ones; `mine: true` or `assigned: "me"`
  for "on me"; `iterations: ["@current"]` for "this sprint"). Every filter takes several values (any of them);
`show: "tree"` when they ask what an item sits under or what is below it. "Run my <name> search" → `team_saved` for the
  names, then `team_search` with `saved: "<name>"` (saving and changing them is the user's, in the Team tab). Answer with one line per item as a mention
  `@[workitem:<conn>/<id>|AB#<id> <title>]`, its state, who has it, and where it already sits in Alfred. More than one
  page: say how many, offer the next page.
- **AB#id, an id or a URL** → `team_item` (fields, comments, attachments by name, "changedSinceCopy" when Alfred keeps
  it) and `team_tree` for its parents and children.
- **"incoming"** → for each open board (`board_boards`): `team_incoming`; propose as `/alfred-triage` does
  (`board_similar`, then `team_propose_card`).
- **"sync"** / "refresh" → `team_refresh_item` per board (it waits for the result: new items, items Azure moved past
  with new comments, the main's move, possible card matches), then `team_board_items` for the before → after of each
  CHANGED item. The main closed or moved out of its iteration → propose, as rules §0a says; never act on it.
- **A person** → `team_people` (by name, or `id` for their card: teams, open items, Alfred cards).

## 2. Putting it on a board

- "Add AB#… to <board>" asked in this message → `team_board_link` with `askedIn` (= the chat message id, or "terminal"),
  `asMain` only when the board has no main yet (changing a main is the user's). Not asked in words → the same tool without `askedIn`: a proposal
  the user approves on the board.
- "Start a board for AB#…" → `team_start` with `askedIn` (rules: only the user opens a board).
- "Make a board for AB#… now" (no setup by Claude) → `team_new_board` with `askedIn` and the project (ask for it when
  no mapping names one); it names the board `#<id>_<title>` and makes a first cycle that does not record.
- "Link it to card #n" → `team_link_card` (with `askedIn` when asked in words). The tracker markers (link back,
  comment, tag) always wait as a bundle.
- A watch rule ("tell me when new refund bugs come in") → describe the search and ask the user to add it under the
  board's Related items → Watch rules; `team_watch_rules` / `team_watch_run` read and run them.

## 2b. A card and its Azure item (specs/030)

- **"update card #n"** (the card's "Draft with Claude", posted to the board chat): `board_get` the card and
  `team_card_items` for its linked item; draft what the tracker should hear - a comment (what was found, fixed or
  decided, the commit and branch), a state when the card's status calls for one, both in one bundle (`team_comment`,
  then `team_move_state` with `extend`). Show the draft in the reply; the bundle waits on the card.
- **"matches #n"** or a card with no item: `team_card_matches` - judge each proposal against the card's repro and
  steps and write why (`id` + `why`); the user clicks Link or Not this one on the card. No proposal and no match by
  `team_search` → offer "Create in Azure": `team_create_item` (a Bug for a BUG card, a Task for a TASK card) - it goes
  under the board's main item and is linked to the card once the user approves the bundle.

## 3. Telling the tracker

`team_comment`, `team_move_state`, `team_create_item` prepare a **bundle** - on the card when there is one (pass
project + number), else on the board (pass `board`); `extend` to add a step to a waiting one. Text only in your words: no secrets, tokens, cookies or raw
request bodies; evidence files are built masked by the user's browser when they open the bundle. Say "it waits for your
approval on card #n" - never that it was sent, never approve it yourself.

## Finish

One line per thing done or proposed and what waits on the user. On a board: `board_session_log` (did / found / next).
