# Contract: db-agent log tagging

**Switch in**: per request, the `X-Alfred-Call` header's `log=1` (the reverse proxy adds it while the project's ▤
switch is on - `proxy/log-link-enabled.flag`). No agent setting; the key is the constant `alfred.call`.

**Behaviour** (`CaptureDispatcher.servletEnter/servletExit`, `wrapRunnable`):

1. Request arrives with `X-Alfred-Call: id=<callId>; db=0|1; log=1…`. If `log=1`, `id` is put under
   `alfred.call` in every logging MDC found through the thread's context class loader:
   `org.jboss.logmanager.MDC`, `org.slf4j.MDC`, `org.apache.logging.log4j.ThreadContext`, `org.apache.log4j.MDC`,
   `org.jboss.logging.MDC` (each probed once per class loader, cached; missing = skipped).
2. The previous value (if any) is remembered and restored on `servletExit` in a `finally`; tasks wrapped by
   `wrapRunnable` set/restore the same key around `run()`.
3. No header, no `id`, or no `log=1` → nothing is touched. Statement capture still requires `db=1`.
4. Any failure is logged once per kind by `AgentLog` and never reaches the application.

**The CALL_OPEN marker** gains `thread` (the request thread's name), for every call with `db=1`.

**Guarantees**: the application's behaviour and log content are unchanged except the added MDC entry
(FR-008); overhead < 1 ms per request (SC-004); Java 8 compatible; no new dependencies.

**What odeysys's log shows** (WildFly JSON formatter, MDC enabled - the default):
`{"timestamp": "…", "log.level": "INFO", "process.thread.name": "default task-4", "mdc": {"alfred.call": "500d0cdc-…"}, …}`
→ the Logs tab flattens it to the field `mdc.alfred.call` (the default `callIdField`).
