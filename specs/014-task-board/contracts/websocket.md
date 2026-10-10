# WebSocket: /ws/board (014)

Signal only; clients re-fetch what they show. Gateway already routes `/ws/`.

```json
{ "type": "board-changed", "project": "odeysys", "cycleId": "c-81", "cardId": "…", "what": "card|activity|brief|specs|checklist|deleted" }
{ "type": "agent-status", "project": "odeysys", "state": "WATCHING", "cycleId": "c-81", "callsChecked": 14, "cardsAdded": 3, "lastCheckAt": "…" }
```

- `cycleId` / `cardId` absent when not relevant.
- Bulk actions send one `board-changed` per project, `cardId` absent.
- Frontend: `BoardSocketService` via `reconnectingSocket`; on reconnect, re-fetch the open view.
