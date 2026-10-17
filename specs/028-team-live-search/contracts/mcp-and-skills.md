# MCP tools and skills (028)

Every tool calls REST with `X-Alfred-Actor: claude`. Claude never receives a token; with none live a read answers `TOKEN_MISSING: enter your token in the Team tab`.

## Reads
| Tool | Input | Output |
|---|---|---|
| `team_search` | conn?, text?, every filter of the search body, `mine` (bool or list of sources), page | rows (id, type, title, state, assigned, iteration, boards) + total + fullText |
| `team_query` | conn?, wiql (SELECT only), max ≤ 200 | rows |
| `team_item` | conn?, id, include? | the live item; for a full copy also `copy` + `diff` |
| `team_tree` | board? or (conn, id), expand? (ids or types), depth?, types?, state? | references + expanded full items |
| `team_items_live` | conn?, ids ≤ 200, include? | live items |
| `team_attachment` | conn?, id, name | content (text) or size + type (binary), ≤ 10 MB |
| `team_people` | conn?, query? or id? | people; `me` with source |
| `team_board_items` | board, view? | main (copy), card items (copies), references |
| `team_card_items` | card (board, number) | linked items with copies and Azure comments |
| `team_incoming` | board? | waiting entries with matches and proposals |
| `team_watch_rules` | board | rules |

## Writes (all create or extend a consent bundle; the result says it waits for the user)
| Tool | Input | Bundle steps |
|---|---|---|
| `team_board_link` / `team_board_unlink` | board, conn?, id, asMain?, askedIn | LINK_ALFRED (Alfred side, after approval) |
| `team_link_card` / `team_unlink_card` | card, conn?, id | link + HYPERLINK, COMMENT, TAG / UNHYPERLINK, UNTAG, COMMENT? |
| `team_create_item` | card, type, title, area?, iteration?, assignee?, description? | CREATE + markers |
| `team_comment` | conn?, id, text, attach? (`calls:[ids], format: html|json`), card? | COMMENT (+ ATTACH, built redacted in the browser when the user opens the card) |
| `team_move_state` | conn?, id, state, card? | STATE |
| `bundle` (option on each write) | `extend: <bundleId>` | adds steps to one card |

## Proposals and runs
| Tool | Effect |
|---|---|
| `team_propose_card` | Incoming entry or card ↔ item: `{action: NEW|LINK, card?, reason}`; the user accepts |
| `team_refresh_item` | sync one item (or a board) → diff |
| `team_watch_run` | run a board's rules → new Incoming entries |
| `team_start`, `team_link` | kept (askedIn) |

## Removed
`team_items`, `team_changes`, `team_squads`.

## board tools touched
`board_search mine=true` includes cards owned by / mentioning me and boards whose items are mine; `board_get` returns `owner` and linked items; `board_edit` accepts `owner` (Claude: own Inbox cards only).

## Skills
See the mock's "8 Skills" screen for each change. New `skills/alfred-team/SKILL.md`: description "Work with the team's tracker (Azure DevOps) from Alfred - search (mine, filters, text), add items to boards or link them to cards, start a board, sort Incoming across boards, sync main and card items, prepare Tell Azure updates and watch rules. Every write waits for the user's approval."
