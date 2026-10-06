# Quickstart: Logs linked to calls

1. **Load the log**: Logs tab → new source → odeysys's WildFly JSON log (upload, `/logs` folder or follow).
2. **Link it to the project**: Settings → Database capture → odeysys → Logs: pick the source; thread field
   `process.thread.name`, time `timestamp` (pre-filled); save.
3. **See it**: turn **▤** on for odeysys in the Sources bar, open a captured odeysys call → database window → **Logs** / **Together**; the timeline has a
   Logs lane; the call card shows `▤ Logs N`. (Thread-and-time matching - works on old files.)
4. **Exact linking**: click **▤** next to odeysys in the Sources bar (first time only: restart WildFly to load the new agent) → make a
   request → its lines carry `mdc.alfred.call`; the settings show "found in N lines"; the call's lines show
   `exact`. Calls without database capture now get logs too (Logs marker on their card).
5. **Back from a line**: Logs tab → open a line → "During call ↗ …".
6. **Export**: export the call/cycle → .md/.html/.json contain its lines; import the .json → lines are back.
7. **Claude**: `call_logs` tool on the call id.

Live verification target: call `500d0cdc-ed5b-459e-9afa-ef7c2996949f` (flight search, thread `default task-4`)
with the WildFly log covering 2026-10-05 04:34 UTC.
