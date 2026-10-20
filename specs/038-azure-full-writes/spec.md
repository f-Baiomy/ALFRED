# 038 - Azure work items: everything a person can do, nothing without the user's Approve

2026-10-20. Board AB#62565 showed the gap: two Backend tasks (one under AB#62555, one under AB#62565, Activity
Development, 16 h, tag Back-end, no Alfred marks) could not be drafted. `team_create_item` sent six fields, always used
the board's main item as parent, always added an Alfred comment and tag, needed a card, and Azure's 400 on the required
Activity field came only after the user approved (bundle 9, PARTIAL).

## Rule that does not move

Claude prepares; only the user approves. Every write to Azure is a step of a consent bundle the user approves from the
board UI. Nothing in Alfred deletes or destroys a work item, or touches process, project, area/iteration trees, teams,
permissions or service hooks.

## Requirements

### Writes (all as bundle steps)

- **FR-1 Create, full.** A CREATE step carries any fields by reference name (`fields`, a JSON object), the parent (any
  id; the board's main item only when none is given), extra links (`links`: Related, Parent, Child, Predecessor,
  Successor, Duplicate, Duplicate of, Tested by, Tests), and tags. One Azure request creates it with all of them.
- **FR-2 No card needed.** A create names a card (then it is linked to the card in Alfred) or a board (where it waits).
- **FR-3 Several items, one approval.** A bundle may hold up to 20 steps for different items: each CREATE makes its own
  item; any other step may name its own `item`. Each step keeps its own tick.
- **FR-4 Edit anything.** A FIELD step may set several fields at once (`fields`), re-parent (`parent`, "" removes it),
  add / remove links and tags, and change the state. Before -> after is stored per field when drafted.
- **FR-5 Copy.** `copyOf` on a CREATE copies the source item's writable fields at draft time (shown in full in the
  bundle); given fields win.
- **FR-6 Split.** One bundle of CREATE steps under one parent, inheriting its area and iteration.
- **FR-7 Bulk edit.** One bundle, one FIELD step per item, from ids or a query (at most 20).
- **FR-8 Log time.** Completed Work + h, Remaining Work - h (never below 0), computed from the item's live values.
- **FR-9 Close instead of delete.** A STATE step may name a state category (`Removed`, `Completed`): the type's own
  state in it is filled in at draft time, with a reason comment.
- **FR-10 Mentions.** `@[person:<id>|Name]` in comments and descriptions becomes a real Azure mention.
- **FR-11 Templates.** Named field sets per connection and type, saved by the user or by Claude when asked, applied by
  name on a create (given fields win).
- **FR-12 No Alfred marks unless asked.** The "Followed in Alfred" comment, the `alfred` tag, the hyperlink back, the
  "via Alfred" comment footer and the attachment's "via Alfred" note are added only when the step asks for them. The
  link inside Alfred (card <-> item) is kept.
- **FR-13 Redraft any step.** Claude may change any step of its own waiting bundle (payload keys) or drop one; the
  bundle is checked again. The user still approves the final version.
- **FR-14 Field discovery.** Per project and type: every field with reference name, display name, type, required,
  read-only, allowed values and default. Kept 24 h; dropped when Azure refuses a field.

### Checks and guards

- **G-1 Azure dry run at draft.** Every CREATE and FIELD step is sent to Azure with `validateOnly=true` when drafted.
  Refused -> Claude gets Azure's exact message and nothing is saved. No token -> saved as "not checked yet".
- **G-2 Dry run again at Approve.** If Azure refuses now, nothing is sent and the bundle shows why.
- **G-3 No delete, ever.** The Azure client refuses DELETE and every write outside work items, comments, attachments
  and work-item queries before a request leaves Alfred. A test fails if a connector learns another write.
- **G-4 Approval only by the user.** Approve, reject and retry refuse Claude (`X-Alfred-Actor: claude`), a helper's key
  (the MCP server and the runners use it) and any request through a session (`X-Alfred-Via`). With pairing on, only a
  paired browser approves.
- **G-5 What is approved is what is sent.** Steps cannot change after approval; a redraft or a user edit is a new
  draft that is checked again.
- **G-6 Audit.** Each sent step keeps who approved, when, what was sent and Azure's answer.
- **G-7 Draft limit.** At most 5 of Claude's bundles wait per board; Claude extends one instead of piling up more.
- **G-8 Kill switch.** Settings ▸ Team ▸ "Claude may prepare Azure changes": off refuses every draft from Claude.
- **G-9 Popup for wide changes.** Approve asks once in a popup when a bundle touches more than 5 items, moves an item
  to a closed state, re-parents, or assigns an item to someone else.

## Out of scope

Pull requests, commits and branches; deleting or destroying items; process or project settings; an undo window.

## Wire shape

No new step kind and no new column in a step: new payload keys only (`fields`, `links`, `tags`, `parent`, `item`,
`copyOf`, `template`, `category`, `markers`, `azureCheck`, `sent`), so an older Alfred reading a bundle never meets an
unknown enum value.
