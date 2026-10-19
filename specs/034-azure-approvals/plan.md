# specs/034 - Azure approvals where you are

Mock: `mock.html` (Before / After / Enhancements / What changes). Docs: docs/team.md "Reviewing a bundle where you are".

## Built

- Backend (`backend-teamboards`): bundles made for a card get its board, older ones once at start; state/field steps
  keep `from`, Claude comments keep `draft` (`previous` after a redraft); `GET /teamboards/writes/{id}/check` (live,
  tunnel-guarded) with changed-since and Azure's allowed moves (`StateCatalog.transitions`, Azure work item type
  transitions); reject reason as `note`; `POST …/redraft` (Claude: new text; user: a waiting chat message);
  `POST …/steps/{step}/retry`. Tests in `TeamServicesTest`.
- MCP: `team_bundle`, `team_redraft`; `/alfred-team`: every asked change in one bundle, redraft, read the reject reason.
- Frontend: one review (`TeamConsentBundleComponent`, old → new, word diff vs draft, Raw / Azure preview, ✦ Redraft,
  5 s Undo, reject reason, sent trail, Retry this step); `BundleOutboxService`; header pill + tray (Approve all, keys),
  tile badge, drawer strip above the tabs, chat under Claude's answer, ⇪n in the tab title, "wait on you" counts them.

## Not built

- A line in the card's Activity when a bundle is sent: a user comment there would wake /alfred-live on the card. The
  bundle itself keeps the trail (sent time, results, open in Azure).
