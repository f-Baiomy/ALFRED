# Quickstart: Task Board (014)

How to see the feature working end to end once built. Docker install; the native install is the same from step 2 on.

1. Rebuild: `docker compose up -d --build backend frontend app-gateway` (then `docker compose restart app-gateway` if you get 502s).
2. Open `http://localhost:3000/board`; pick a project. Reloading `/board` must show the SPA, not JSON.
3. Quick add `bug! discount not saved #urgent` → a Bug card, Urgent, in Inbox. Open a second tab: the card is there without reload.
4. Drag it to In progress; open it; the activity shows "You moved Inbox -> In progress".
5. In the description type `@`, pick a call from the Calls tab, a statement, a log line. Hover each chip (preview), click one (opens the item). The Linked list shows all three.
6. Session Cycles → open a cycle → Brief & specs: write a brief, drop `ODY-482-spec.md` (with an "Acceptance" list), paste a second spec as text. Open the viewer. Mark two checklist items.
7. Calls tab of that cycle: mentioned calls show card badges; right-click a call → Add to board → a linked Inbox card appears on both boards.
8. Inbox: close one card as Fine with a reason, one as Not in this flow; Undo one; use Triage mode with F / N / T; select two cards and bulk-close.
9. Claude: in a Claude Code session with the Alfred MCP server, ask "review cycle order-flow-3 against its spec and put findings on the board". Check: cards land in Inbox with the ✦ badge, comments use Did / Found / Next, an issue closed as Fine with a reason is not raised again, and asking Claude to close a card is refused.
10. Export: board → .md, .html, .json; cycle export with both checkboxes on and off (off = same file as before this feature). Import the .json into another project and compare.
11. Delete the cycle: its cards stay, marked "cycle deleted"; its call mentions show as removed chips.

Tests:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/repo" -v alfred-m2:/root/.m2 -w //repo/backend maven:3.9-eclipse-temurin-21 mvn -B -pl backend-board,backend-app,backend-architecture-test -am test
cd frontend && npx ng test --watch=false --browsers=ChromeHeadless --include='src/app/**/board*/**/*.spec.ts'
cd mcp-server && npm test
```
