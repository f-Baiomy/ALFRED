# Review D2 - board chat, US5-US6 (T076-T077)

Reviewed: the D2 diff against FR-020..025, FR-043..045 and mock.html; bug hunt (digest double-show, routing of Ask
Claude, slash list drift, reactions toggling, ask-again supersede). Every finding was fixed with a test.

## What D2 adds

| Requirement | Where |
|-------------|-------|
| FR-020 "looking at" chips | `shared/utils/chat-context.ts` (call / statement / log / card / spec item chips, once each, at most 10); `ChatStateService.ask/chipsOf/removeChip`; the panel shows them above the composer with ✕ and sends them as the message's `context`; the card open in a drawer (`ReturnPointService.openCard`) is offered until left out. |
| FR-021 Ask Claude | `💬 Ask` on every call (`call-actions`: Live Calls and session cycles), on a DB statement (`db-statement-detail`), on a call's log line (`db-log-row`) and `ask` on an Acceptance item (`acceptance-checklist`). The chat is the item's cycle chat when it is in a cycle, else the project chat (`chatScopeFor`). The chat state is resolved on click (`Injector`), so those components need nothing new to render. |
| FR-022 "/" skills | `chat-skills.ts` (13 = shipped minus alfred-live/alfred-listen) listed first in the editor's "/" menu (`mention-editor` `commands` input); a message starting `/alfred-x` is sent with `origin: skill:alfred-x`; the runner tells the chat's Claude to load it with the Skill tool (`skillOf`, `Skill` allowed in the chat pool). |
| FR-023 digest | `ChatDigest` (no model) from the board's history since the last look (`activityIdBefore`) and the cycle's brief/spec/mark changes; `GET /{scope}/digest` (204 when nothing); the panel shows "While you were away" once per opening when the last look is at least the chat's digest gap old (per viewer, `alfred.chat.looked`). |
| FR-024 ★ decision | `POST messages/{id}/decision` - the same DECISION record an answer makes (brief + Undo, `ChatRecordService`); ☆ undoes it. |
| FR-025 questions | Claude's `extra.questions` drawn by `chat-questions.component.ts` (options, recommended, multiSelect, Something else), answered all or some and sent once (`POST messages/{id}/answers`): stored on each question, sent back to Claude as one waiting message in the thread. |
| FR-043 Shared | `GET /{scope}/shared` - every mention (text and context chips), folded messages included, once each with its first message; 🗂 in the panel, ↗ jumps to the message. |
| FR-044 reactions | `POST messages/{id}/react` toggles the board's reactions plus ❓; ❓ on Claude's answer queues "explain more" as a waiting message in the thread. |
| FR-045 ask again | `POST messages/{id}/again` - the answer stays, marked asked again (`superseded`, no longer counts open questions), the question goes back with what to read (log lines / SQL / acceptance items) and the user's words. |

## Findings

| # | Kind | Finding | Fix | Test |
|---|------|---------|-----|------|
| F1 | Bug | The digest effect followed the chat's settings; settings arriving after the digest cleared it again (digest shown then gone). | Settings read untracked. | covered by the code path; settings and digest load independently |
| F2 | Bug | The runner never told Claude a message was a picked skill: the prompt edit had not applied (a heredoc replace that matched nothing). | Applied with the editor; `chatPrompt` adds the Skill line per message. | `chat-runner.test` "a skill picked from the chat…" (failed first) |
| F3 | Drift | The "/" list could drift from the shipped skills. | `test_alfred_skill.py` compares `chat-skills.ts`, `chat.mjs CHAT_SKILLS` and `alfred_skill.SKILLS`. | `test_the_chat_slash_list_is_every_shipped_skill_but_the_two_that_run_the_chat` |
| F4 | Gap | FR-020 names the spec item; no place offered it. | `ask` on each Acceptance item. | manual |
| F5 | Routing | Asking about an outbound call has no project (its project is unknown) - it goes to the "No project" chat. | Kept: an outbound call belongs to no project's inbound log; asking in a cycle takes the cycle chat. | `chat-context.spec` |
| F6 | Toggle | A reaction pressed twice must leave nothing, and ❓ twice must not queue two explain messages. | Toggle removes; a waiting explain message is only added when the reaction is added. | `ChatDigestServiceTest.reactionsToggle…` |
| F7 | Supersede | Asking again twice on the same answer. | Refused (CONFLICT); asking again on a user message is NOT_FOUND. | `ChatDigestServiceTest.askingAgain…` |

Digest double-show: the digest is fetched once per opening (scope change) and the last look is moved to now at once, so a
second opening inside the gap shows none.

Known limit: the digest is built from the board's history (cards, brief, spec files, marks). Requirement verdict changes
and failed calls are on the board as Claude's cards and comments, so they appear through those; a separate verdict feed
was not added.
