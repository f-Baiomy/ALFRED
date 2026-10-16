# Quickstart: verify Boards rework and Team tab

Run from the repo root. Backend tests need JDK 21 (see CLAUDE.md for the Docker Maven line).

## 1. Automated

```bash
cd backend && mvn -B -pl backend-board,backend-session-cycles,backend-teamboards/teamboards-core,backend-teamboards/teamboards-azure,backend-app,backend-architecture-test -am test
```

```bash
cd frontend && npm test && npm run build
```

```bash
python -m pytest tests/python/test_alfred_skill.py
```

Must pass:
- **Migration**: `BoardModelMigrationTest` (old-schema fixture, SC-001 counts, second run is a no-op).
- **Board REST**: `BoardsControllerTest`.
- **Shared cycles and finding homes**: `RequirementServiceTest` (per-board verdicts, Archived skipped), `ListenHomeTest` (evidence instead of a duplicate, ask on several boards).
- **Cycle delete**: `CycleDeletePlanTest` (kept per board, rest deleted).
- **Connector boundary**: `HexagonalArchitectureTest` (teamboards isolation, connector ↛ core, core ↛ connector).
- **Token**: `TeamTokenNeverStoredTest` (SC-007).
- **Azure connector**: `AzureConnectorTest` against recorded fixture responses.
- **Gateway and SPA filter**: `SpaPageFilterTest` (`teamboards` prefix).
- **Frontend boundary**: `check-team-boundaries.mjs`.

## 2. Migration on real data

1. Copy a real `data/board.db` and `data/session-cycles.db` into a scratch Alfred.
2. Count cards, briefs, spec files, chat messages per project or cycle.
3. Start the new build.
4. Check:
   - every count is reachable on exactly one board;
   - each briefed cycle shows "Migrated from cycle …";
   - restarting twice changes nothing.

## 3. Boards by hand (Docker or native)

1. On the Board tab:
   - create "Login lockout" with a first recording;
   - relate an old cycle;
   - switch "Own only" on and off.
2. Relate one cycle to two boards with different Acceptance items, then open Session Cycles:
   - the cycle shows under both groups;
   - "Calls" shows two verdict columns, and the "for <board>" filter works.
3. While that cycle records, press Record on a third board of the same project:
   - "Join" relates it;
   - "New" pauses the old cycle.
4. Run `/alfred-listen <cycle>` and make a known finding happen twice:
   - it adds evidence, not a new card;
   - a finding both boards name gets a question in chat.
5. Delete a cycle that cards on two boards mention:
   - the dialog numbers match;
   - two "kept from" cycles appear.
6. Run `/alfred-live <board>`, then write in that board's chat:
   - the answer comes from that terminal;
   - after stopping it, the project runner answers;
   - with neither, the message waits.
7. Archive a board:
   - it leaves the picker;
   - new calls are not judged for it;
   - reopening it works.

## 4. Team tab (needs an Azure DevOps org and a read-only PAT)

1. In Settings → Team connections:
   - add `https://dev.azure.com/<org>`;
   - paste the PAT;
   - pick one project and team.
2. Team tab → Refresh:
   - items appear with "fetched just now";
   - open an item and check all fields, links and full history.
3. Clear the PAT: the shared cache stays, with a notice. Use a revoked PAT: you get the token error.
4. Map the sprint to a board, then press ▶ Start on a bug:
   - the button shows waiting → running → Open task;
   - the new board has the seeded brief, Acceptance items, the work item chip, the related board and a recording cycle.
5. In any board chat write `open a board for AB#<id>`: a board opens, related back to that board.
6. Edit the bug's acceptance criteria in Azure, then Refresh:
   - the board shows "Azure changed";
   - Review → Save updates the item.
7. Search for the PAT's value in `data/`, the logs and an export: no hits.
8. Through the tunnel: Team settings are read-only, and the PAT still works.

## 5. Compatibility

- Import a pre-027 board export: everything lands on the default board.
- Import a 027 export into the previous release: no error, and boards are ignored.
