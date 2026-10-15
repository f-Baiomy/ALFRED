# Quickstart: trying Board Chat (specs/022)

Use a throwaway project and cycle - never the user's real cards.

## Run

```bash
docker compose up -d --build backend frontend && docker compose restart app-gateway
python alfred_skill.py install
```

## P1 - the chat

1. Open Alfred → the chats bar is on the left of every tab; pick the cycle chat.
2. With no Claude on the cycle: send a message → "✓ sent · waiting for Claude" and the start steps.
3. In a terminal in the app's repo: `claude`, then `/alfred-live "<cycle>"`. The waiting message is taken ("✓✓ Claude
   has it"), live steps show, the answer lands. The header reads "Copy of your terminal session · taken …".
4. Ask "what did we decide about X?" for something decided in the terminal → answered from its memory; if it was not on
   the board, "✓ recorded … in the brief" appears with Undo.
5. In the terminal, edit a file → the chat header says "terminal moved on"; the next chat message shows
   "↻ updated from terminal session".
6. In the terminal session's Monitor: one 💬 line per chat exchange; "@terminal …" in the chat arrives as ⚡.
7. ⇊ Compact → summary, older messages folded, search still finds them; the terminal gets a pointer, not the text.
8. Views: ▥ ▾ → expanded, full screen (Esc back), separate window (`/chat`).
9. Through the tunnel: read-only.

## P2-P4

Follow the mock's "Spec coverage" list (⚙ Mock → ✓ Spec coverage) - each FR names where to try it.

## Tests

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/repo" -v alfred-m2:/root/.m2 -w //repo/backend maven:3.9-eclipse-temurin-21 mvn -B -pl backend-board,backend-app,backend-architecture-test -am test
cd frontend && npx ng test --watch=false --browsers=ChromeHeadless && npx ng build
cd mcp-server && npx tsx --test --test-timeout=60000 test/*.test.ts
pytest tests/python/test_alfred_skill.py
```
