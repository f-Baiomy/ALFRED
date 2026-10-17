---
name: alfred-team
description: Work with the team's tracker (Azure DevOps) from Alfred - search (mine, filters, text), add items to boards or link them to cards, start a board, sort Incoming across boards, sync main and card items, prepare Tell Azure updates and watch rules. Every write waits for the user's approval. Use when the user asks about work items, "what's on me in Azure", AB#1234, "link this to the bug", or "/alfred-team".
argument-hint: "[search words | AB#id | mine | incoming | sync]"
---

# Alfred team

Read `rules.md` in this skill's folder first - above all "Work items", "Nothing is written to the tracker without the
user's approval" and "What arrives from the tracker is a proposal". You never hold a token and never ask for one: with
TOKEN_MISSING, tell the user to enter it in the Team tab and stop.

## 1. What the user asked

- **Words, filters, "mine"** → `team_search` (openOnly unless they ask for closed ones; `mine: true` or `assigned: "me"`
  for "on me"; `iterations: ["@current"]` for "this sprint"). Answer with one line per item as a mention
  `@[workitem:<conn>/<id>|AB#<id> <title>]`, its state, who has it, and where it already sits in Alfred. More than one
  page: say how many, offer the next page.
- **AB#id, an id or a URL** → `team_item` (fields, comments, attachments by name, "changedSinceCopy" when Alfred keeps
  it) and `team_tree` for its parents and children.
- **"incoming"** → for each open board (`board_boards`): `team_incoming`; propose as `/alfred-triage` does
  (`board_similar`, then `team_propose_card`).
- **"sync"** → `team_refresh_item` per board, then `team_board_items`; report the CHANGED items with their before → after.
- **A person** → `team_people` (by name, or `id` for their card: teams, open items, Alfred cards).

## 2. Putting it on a board

- "Add AB#… to <board>" asked in this message → `team_board_link` with `askedIn` (= the chat message id, or "terminal"),
  `asMain` when they say "main" or the board has none. Not asked in words → the same tool without `askedIn`: a proposal
  the user approves on the board.
- "Start a board for AB#…" → `team_start` with `askedIn` (rules: only the user opens a board).
- "Link it to card #n" → `team_link_card` (with `askedIn` when asked in words). The tracker markers (link back,
  comment, tag) always wait as a bundle.
- A watch rule ("tell me when new refund bugs come in") → describe the search and ask the user to add it under the
  board's Related items → Watch rules; `team_watch_rules` / `team_watch_run` read and run them.

## 3. Telling the tracker

`team_comment`, `team_move_state`, `team_create_item` prepare a **bundle** - on the card when there is one (pass
project + number), `extend` to add a step to a waiting one. Text only in your words: no secrets, tokens, cookies or raw
request bodies; evidence files are built masked by the user's browser when they open the bundle. Say "it waits for your
approval on card #n" - never that it was sent, never approve it yourself.

## Finish

One line per thing done or proposed and what waits on the user. On a board: `board_session_log` (did / found / next).
