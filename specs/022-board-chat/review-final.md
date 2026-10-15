# Final review - board chat, D1-D4 (T093-T095)

One pass per constitution principle, in order, over the whole feature.

## I. Security by Default

- Every write route under `/board/chats` (messages, edit, cancel, urgent, decision, react, again, answers, proposals,
  undo, consent, settings, compact, refresh, take, reply, summary, session, terminal, delivered, release, system, watches)
  is a POST/PUT/DELETE under `/board/`, so `BoardEditAccessInterceptor` refuses it through the tunnel.
- DTOs carry Bean Validation: text 64 KB, quote 4 KB, context ≤ 10 mentions, records ≤ 20, terminal items ≤ 11, answers
  ≤ 20 × 2 KB, proposal ids ≤ 50, emoji ≤ 16, ask-again text 4 KB; the service also caps `extra` at 256 KB.
- Every size the client sends is clamped server-side: page 1..100, export page 1..200, search ≤ 200 hits / 200 chars,
  `after` and `since` ≥ 0.
- Claude-only and user-only actions are enforced in the services (take/reply/summary/session/terminal/system for Claude;
  undo, ★, reactions, answers, proposals, consent, settings for the user).
- Everything sent to the terminal is masked (`maskProseWith`); no transcript ever reaches Alfred (only ids, times, host).
- No `innerHTML`/`bypassSecurityTrust*` in the chat components; text renders through the board's markdown view; visuals
  run in the unchanged locked snippet frame (`snippet-security.spec.ts` green).
- Logs carry `e.toString()` only, never message text.

## II. Performance at Real Scale

- No polling: the chat re-reads on the `chat-changed` signal; the runner hears the terminal through `fs.watch`; watches
  fire on completed calls and the board's signal. The only timers are one-shot UI dismissals (the Undo toast).
- SQL is indexed and windowed: `idx_chat_messages_chat (project, cycle_id, id)`, waiting by `wait_seq`, records and
  terminal items by message id, watches by project; every list has a `LIMIT`.
- The watch work runs on its own thread; a completed call never waits for it.
- Retention: chat messages are kept until their cycle is removed (documented in docs/board.md "Board chat").
- Undo tokens expire after 60 s and are swept on each accept.

## III. Hexagonal vertical slices

- Everything lives in `backend-board`: ports in `application/port/in|out`, services in `application/service`, adapters
  in `adapter/in/web` and `adapter/out/sqlite`. The only cross-slice wiring is in `backend-app/boardbridge`
  (`BoardCycleNamesAdapter`, the chat hook in `BoardRetestWatchAdapter`). ArchUnit green.

## IV-V. Style and cleanliness

- Reused, not forked: mention editor (+ a `commands` input), mention chips, markdown view, live-work box, consent
  dialog, resend dialog, rule editor, quick-answer's question shape, the board's reactions, BoardChangeFeed.
- Pure helpers carry their own specs (`chat-queue`, `chat-bar`, `chat-context`, `chat-skills`).

## VI. Verified changes

- Backend: `SqliteChatRepositoryTest`, `ChatServiceTest`, `ChatControllerTest`, `ImportBoardServiceTest` (chats),
  `ChatDigestServiceTest`, `ChatProposalServiceTest`, `ChatWatchServiceTest`, `BackendContextStartsTest`,
  `BoardEditAccessInterceptorTest`, ArchUnit.
- MCP: `chat.test.ts`, `chat-runner.test.ts`, `live-runner.test.ts`; skills: `test_alfred_skill.py` (incl. the "/" list).
- Frontend: chat specs (panel narrow layout, proposals, bar, context, skills, queue) and the full suite.

## Spec coverage walk (T095)

FR-001..060 were walked gate by gate in review-d1..d4. Known limits, written where they apply:
- the digest uses the board's history only (review-d2);
- a checklist mark set by an accepted proposal cannot be cleared by Undo (review-d3 F6);
- "watch while I test" ends when turned off, not when the cycle stops recording (review-d4);
- the chat's Claude does not edit code (review-d3 F9).
