# Review D3 - board chat, US7 (T083-T084)

Reviewed: the D3 diff against FR-026..029 and FR-046; bug hunt (double accept, accept during a card move, undo after the
window, consent bypass, tunnel accepts).

## What D3 adds

| Requirement | Where |
|-------------|-------|
| FR-026 proposals | `ChatProposalService` + `ChatProposalController`: `extra.proposals` of kinds verify / close (Fine) / move / mark (with call evidence) / item; `GET messages/{id}/proposals` checks each open one against the board when shown, `POST` accepts/declines one or many and checks again first; applied as the USER. `chat-proposals.component.ts`: Accept / Decline, ticks + "Accept N ticked", "Accept all"; a stale one shows why and has no Accept. |
| FR-046 undo | An accept returns an undo token kept 60 s in memory; `POST /board/chats/undo/{token}` restores (move back, undo close, the previous mark, the spec file as it was) and reopens the proposals. The toast stays 8 s. |
| FR-027 reply → card | "→ Card" on any message: the message or the selected part, posted as a comment on card #N with `From the board chat: @[chat:…]`. |
| FR-028 resend / rule | `extra.consent` {kind resend/rule, summary, call}: `chat-consent.component.ts` - "Review…" shows the board's consent dialog; only a yes opens the existing resend dialog (sends nothing until its Send) or the rule editor (saves nothing until Save); the decision is recorded (`POST messages/{id}/consent`, once, the user's). |
| FR-029 fix report | The chat's rules: a code change → `board_fix` (changed files as code mentions, the short diff, the re-test plan) then the FIX record (D1). |

## Findings

| # | Kind | Finding | Fix | Test |
|---|------|---------|-----|------|
| F1 | Bug | `[...ticked()]` in a template: Angular templates have no spread - the component did not compile (JIT failed in the panel tests). | `acceptTicked()`. | `chat-proposals.component.spec` |
| F2 | Bug | `@else if (…; as why)` - `as` only on the first `@if` block; compile error. | Read the value directly. | `chat-proposals.component.spec` |
| F3 | Race | Two accepts of the same proposal (double click, two tabs). | `decide` is synchronized and a proposal with a state answers "already applied". | `ChatProposalServiceTest.acceptedProposals…` |
| F4 | Race | The user moved the card between the proposal and the accept. | Checked again at accept: "already done" / "outdated: …", never applied. | same test (`m` already done) |
| F5 | Window | Undo after the minute. | Refused (CONFLICT), the board stays. | `ChatProposalServiceTest.undoIsRefusedAfterTheMinute…` |
| F6 | Limit | A checklist mark that was empty before cannot be cleared (the board has no "unmark"). | Undo says so for that one and puts the rest back. | `acceptedProposals…` |
| F7 | Consent | Could the chat run a resend or a rule without the dialog? | No: the backend only records yes/no; the actions themselves are the existing resend dialog and rule editor, each with their own confirm. Claude cannot record a consent (REFUSED_FOR_CLAUDE). | `ChatProposalServiceTest.aConsentIsDecidedOnce…` |
| F8 | Tunnel | Accept / undo / consent through the tunnel. | All are POSTs under `/board/` - BoardEditAccessInterceptor refuses them like every board write. | `BoardEditAccessInterceptorTest` (board writes) |
| F9 | Scope | The chat's session has no edit tools (Read/Grep/Glob, git read-only), so it does not change code beside the terminal session working in the same folder. | Kept on purpose; a fix asked in the chat is answered with the plan and the command to run in the terminal, and a fix made elsewhere is reported with `board_fix` + FIX. | - |
