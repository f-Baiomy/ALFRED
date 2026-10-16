# Card drawer redesign (v3) - implementation plan

Mock: `mock-card-redesign-v3.html` (chosen). Frontend only - no backend or API change.

## Pieces

1. **Header** (`card-drawer.component.ts`)
   - Bar: `#N` pill (copies `#N`), kind, ✦ Claude, cycle by name (`SessionCyclesApiService.get`, cached; the id on hover),
     waiting, ❓ N, ▶ run (`app-run-skill`, unchanged), ⋯ menu, ‹ › pager, Side/Full/Window icons, ✕.
   - ⋯ menu: Copy as issue, Copy cycle id, Expand all / Fold all sections, Compact spacing, Keyboard shortcuts,
     Delete card… (confirm as today).
   - Title (click to rename), "Mentioned as" line (✎ on hover).
   - One chip line: Status / Kind / Scope (`app-select-picker`, as today), active flags + "⚑ +" menu, teams (✕ on hover)
     + "+ team".
   - Journey line: Inbox › To do › In progress › Fixed › Verified › Done with the date each was reached (STATUS
     entries), the current one marked, a proposed Verified marked; click moves the card (same path as the Status
     picker). Closed cards show "Closed · resolution" at the end.
   - Shrinks to one line (#N · title · status · ⋯ · ✕) once the body scrolls past 40 px.
2. **Needs you** (above the tabs): proposal (Accept / Dismiss, evidence folds), open questions (Answer → the
   existing dialog), blocked (→ Links tab), re-test failing (→ Re-test tab); context-only notes (looks like #N,
   reason) fold to "▸ N notes"; alone they are a closed "Notes" section; nothing → no section.
3. **Tabs (side view)**: Activity · Details · Links · Re-test with counts/state (● running is the live-work box,
   🔒 blocked, re-test verdict). Default Activity when there are comments, else Details. Full/Window: no tabs -
   main column (needs you, details, activity) + rail (links, re-test, runs).
4. **Sections** fold by state; the user's choice per section is kept in this browser (localStorage, try/catch):
   Description open (folded to ~12 lines only when long), Attached open, Runs closed.
5. **Activity** (`activity-timeline.component.ts`): inputs `filter` (all/comments/changes), `newestFirst`,
   `query`, `newSince`. Day dividers; avatar + name + time (full date on hover); hover bar ☺ ↩ ⧉ ⋯ (direction,
   wrap, edit, history); thread foot "Reply…"; threads with > 4 replies fold the middle; older answered threads
   (not the last two, never an open question) fold to one line; runs of change entries group to one dim line.
   "N new since you looked" bar (`BoardSeenService.seenAt` read before `markSeen`), new comments ringed;
   🔍 find filters threads; Jump ↓ / Mark seen.
6. **Comment box**: the existing compact editor (`[compact]="true"`, one line), "✓ draft saved" in its bar; quick
   replies when Claude waits on the user: ✅ Go ahead (✅ on Claude's latest comment), ❓ Answer the N questions,
   Explain more / Not now (a reply to Claude's latest comment).
7. **Keys** (no clash with the board's 1-6 / N / F / T / J / K card keys): `[` `]` previous/next card in the same
   column, Shift+1..4 tabs, `E` edit the description, `/` write a comment, `?` the card's key list.
   `board-view` leaves `/` and `?` to the drawer while a card is open.
8. **Re-test**: `app-card-retest` emits its verdict chip (for the tab label and the needs-you row); it stays
   rendered (hidden) off its tab so the verdict is known.

## Not changed

Every action, dialog and API call of today's drawer stays (see the mock's "Nothing dropped" table); the
board's own keys keep working when no card is open.

## Tests

Timeline spec (folding, new marks, filter, find), drawer spec (header, needs-you rows, tabs default, journey),
mention-editor draft indicator; full frontend suite + production build.

## Outcome (2026-10-16)

Built as planned. Changes from the plan, found in the code review:
- "New since you looked" and "description changed" compare times as instants (`after()`), not as text.
- "Needs you" folded by hand is remembered per card, so it never hides another card's new proposal.
- ✅ Go ahead is offered only while the user's ✅ is not on Claude's latest comment yet (✅ toggles).
- The shrunk header keeps the full one rendered (hidden), so ▶ and R still work while scrolled.
- The header shrinks only when there is enough to scroll that shrinking cannot undo itself.
- Esc closes the key list before the card (the overlay counts as a dialog for the board).
- The journey ticks only steps the card really went through.
- A reference to a comment unfolds its thread (and hidden middle replies) before scrolling to it.
- The thread "fold" link shows on hover only.
- The shrunk header opens in place (title, ▾ or the ⚠ pill): the whole header and "Needs you" show above the
  activity without scrolling it up; ▴ or scrolling on shrinks it again.
- The activity's filter bar stays in view under the tabs. Earlier history comes in 15 threads at a time, and the
  timeline is OnPush, so a long card stays smooth.
- Full screen and the window keep the tabs (no two-column layout, which left a wide empty gap) and use their whole width.

## Comment threads (mock-comments-e.html, built 2026-10-16)

- Replies are a tree: backend keeps `answers` (the reply a reply to a reply was written to; `reply_to` stays the
  thread's first comment, so questions, reactions and Claude's tools are unchanged). Old replies hang under the first
  comment.
- Each level steps 1 rem right (avatar and text together), with a clickable rail that folds. All replies start folded,
  level 1 too ("▸ N replies · K new"); one click opens one level. ⊞ / ⊟ open or fold all; Find opens all.
- ↩ on a reply answers that reply; a sent reply keeps its branch open.
- Did / Found / Next as blocks with a heading line; "Reply" part has no heading; smaller avatar.
- Review fixes: a reply whose `answers` is missing or later than itself hangs under the first comment (never dropped).
