# MCP tools (014) - `mcp-server/src/tools/board.ts`

All calls send `X-Alfred-Actor: claude`. Output is text (as other tools), masked with the session's masking rules where it quotes call data. Claude's limits (FR-042) are enforced by the backend; the tools below simply do not offer forbidden operations.

| Tool | Input | Does |
|------|-------|------|
| `board_list` | `project`, `cycleId?`, `status?[]`, `kind?[]`, `flag?[]`, `limit?` | Lists card summaries: `#n KIND [flags] title - status (cycle)`. |
| `board_get` | `project`, `number` | One card: description with mentions resolved to readable lines, links, full activity oldest first. Meant for resuming work. |
| `board_add` | `project`, `kind`, `title`, `description` (with mentions), `flags?`, `cycleId?`, `links?` | Adds a card to the Inbox (always). Returns the number. The backend refuses (409) while the live strip is paused, and when the card's call links give the same signature as a card closed as FINE or NOT_IN_FLOW; the tool relays that message word for word (it names the closed card and its reason). |
| `board_comment` | `project`, `number`, `did`, `found`, `next`, `impact?` | Posts a Did / Found / Next (/ Impact) comment. All three of did/found/next are required (the backend refuses Claude free text). |
| `board_move` | `project`, `number`, `status: TO_DO\|IN_PROGRESS\|FIXED` | Moves a card. |
| `board_flag` | `project`, `number`, `add?[]`, `remove?[]` | Changes flags. |
| `board_closed_reasons` | `project` | Closed cards with resolution, reason and signature - read before reporting. |
| `get_brief` | `cycleId` | The cycle brief and the list of spec files. |
| `read_spec` | `cycleId`, `name`, `section?` | Spec file text, or one section; plus checklist marks for its acceptance items. |
| `board_status` | `project`, `cycleId?`, `state`, `callsChecked`, `cardsAdded` | Updates the live strip; returns `paused: bool` so a watch loop knows to stop. |

Server instructions (`mcp-server/src/prompts.ts`) gain one paragraph: add findings with `board_add`, record progress with `board_comment`, read `board_closed_reasons` first, never ask to close or set scope.
