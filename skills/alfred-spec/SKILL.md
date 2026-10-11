---
name: alfred-spec
description: Add or change a session cycle's brief or spec files in Alfred - write a brief, add test steps, add a spec from pasted text / a file / a ticket, or edit one Acceptance item - always showing a before/after and asking before saving. Use when the user says "add a spec", "update the brief", "change acceptance 3", or "/alfred-spec".
argument-hint: "<cycle> [brief | add <file> | edit <file>] [\"what to change\"] [--dry]"
---

# Alfred spec

Read `rules.md` in this skill's folder first and follow it.

## Find the cycle and what to change

The cycle by name or id (`list_cycles`). Read what is there: `get_brief` (brief, test steps, spec files),
`read_spec` for the file concerned (its text and the Acceptance checklist with the user's marks and the cards per item).

| Input | Do |
|---|---|
| `brief "…"` | change the brief - add or reword a part, add / reorder test steps |
| `add <file>` + pasted text, a file path in the repo, or a ticket description | create a spec file; turn loose text into the spec shape below |
| `edit <file> "…"` | change one part of a spec (an Acceptance item, a section) |
| nothing more | ask what to add or change |

Spec shape (keep the user's wording where it is already precise):
```
# <title>

## Acceptance
1. <one testable behaviour per line>

## Out of scope
- <...>
```
Brief test steps go under `## Test steps` as a numbered list, one action per step.

## Show, ask, save

1. Show the change as before → after (only the lines that change; the whole text for a new file).
2. Say what it affects: an Acceptance item whose text changes loses the user's mark (its key is the text) and the
   card links to it - name those cards (from `read_spec`'s `cards #n` per item); a removed test step loses its tick.
3. Ask "Save this?". Only on yes:
   - small change → `board_edit_spec` (`name` = the file, or `brief`), with `find` exact text that occurs once;
   - new file or a rewrite → `board_put_spec` / `board_set_brief`.
4. The user can Restore previous in the Brief tab - say so once.

`--dry`: show the change and the effects, and stop.

## Finish

`board_session_log` on the cycle (did: what changed; found: effects; next). If marks were reset, suggest
`/alfred-review <cycle>` or `/alfred-verify` to check the changed items again.
