# Quickstart: check 028 end to end

Needs an Azure DevOps organisation and a PAT with Work Items (Read & Write) and Identity (Read). Steps marked (fake) run against the recorded-fixture connector in tests.

1. **Upgrade**: start Alfred on a 027 data folder → the Team tab shows the one-time notice; `teamboards.db` has no `items`/`changes` tables.
2. **Token**: Team tab → paste the PAT → "token live · <you> · 8 h"; restart the backend → it asks again. `grep -r <pat>` over the data folder and logs finds nothing.
3. **Search**: text "refund", Type Bug, Open only → results in < 3 s; page 2; switch Open only off; a project without full-text search shows the title-only banner.
4. **Start**: Add ▾ → Start board on a User Story → /alfred-setup runs; the board's Related items shows the story as ★ main, its Feature/Epic above and its tasks below as references; Task tab seeded from it.
5. **Tree**: click a Task reference → details fetched live; in Azure add a child task → Refresh → "new on sync" + an Incoming entry; move a child away → "left the tree".
6. **Main**: Make main on the Feature → tree re-roots, re-seed offer.
7. **Incoming**: watch rule "Type Bug, Area Payments" → create a bug in Azure → open the board → the bug waits in Incoming with a "Looks like #n" match; ask Claude in chat "what should we do with it" → Claude's proposal appears; accept Link → the card has the pill and strip; Azure shows the hyperlink, comment and tag only after you approve the bundle.
8. **Card → Azure**: on a card with no link: Create in Azure → approve → the new Azure bug has the card link.
9. **Tell Azure**: verify the card → Tell Azure bundle (state, evidence, redacted .html); untick nothing, approve → Azure shows the state, the comment ending "via Alfred: board …" and the attachment with tokens masked.
10. **Close in Azure**: close the bug in Azure → Refresh → the card shows "Closed in Azure" and a move proposal.
11. **Hook**: Settings → copy the hook URL and secret → Azure service hook "Work item created" → create an item matching the rule → it appears in Incoming without opening the board; stop the token → ping again → it waits under "Waiting ids"; enter the token → it arrives.
12. **People**: Teams tab shows names; your pill says "me"; "This is me" on another pill → `team_people` (MCP) reports the override; mention a person in a comment; set a card owner; Mine shows the eight counts.
13. **Cycles**: a cycle page shows calls only with its boards; the cycles list grouped by board shows "Not on a board".
14. **MCP**: `team_search mine=true`, `team_tree expand=Bug`, `team_items_live` 50 ids, `team_comment` → returns a bundle id and Azure is unchanged until you approve.
15. **Skills**: `python -m pytest -q tests/python`; `/alfred-team` installs with the others.
