# Quickstart / live checks: Log lines caught by the agent (009)

1. **Load the new agent**: rebuild `db-agent` and restart WildFly once (`python3 restart.py` as Administrator, or from
   IntelliJ). The ◆ popover shows "agent attached".
2. **Turn ▤ on** for odeysys (no log source needed - remove the `wildfly` source link to prove it). Hover ▤: "caught by
   the agent".
3. **Make a request** (login, flight search) and open the call: Logs view lists the lines of MainLogger, DetailLogger,
   Hibernate and the container for that request, each with logger and thread; an exception line shows its stack.
   Compare with `main.log`/`server.log` for that thread and time: every line is there (SC-001).
4. **Together**: statements, supplier calls and lines interleaved in their exact order (seq).
5. **No capture**: turn ◆ off, keep ▤ on, make a request: the card's ▤ chip opens the logs-only window with caught lines.
6. **Outside any call**: restart a deployment or let a scheduler fire: "outside any call" shows its lines by thread.
7. **Caps**: a request logging > 5,000 lines shows "N lines not kept".
8. **Concurrency**: 100 concurrent recorded calls - no line on the wrong call (SC-002).
9. **Cost**: `OverheadMeasurementIT` log case < 5 % (SC-003); record in docs/db-capture.md.
10. **Exports / import / Claude**: export a cycle with caught calls as .json, import it, `call_logs` - same lines.
