package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.AgentLog;
import com.fathy.alfred.dbagent.bootstrap.Bridge;
import com.fathy.alfred.dbagent.jdbc.BeforeImageReader;
import com.fathy.alfred.dbagent.jdbc.CaptureOnlyInterceptor;
import com.fathy.alfred.dbagent.jdbc.CascadeInspector;
import com.fathy.alfred.dbagent.jdbc.IndexInspector;
import com.fathy.alfred.dbagent.jdbc.StatementInterceptor;
import com.fathy.alfred.dbagent.sql.SqlShape;
import com.fathy.alfred.dbagent.transport.AgentSettings;
import com.fathy.alfred.dbagent.transport.MarkerRecord;
import com.fathy.alfred.dbagent.transport.OriginRecord;
import com.fathy.alfred.dbagent.transport.Outcome;
import com.fathy.alfred.dbagent.transport.StatementRecord;
import com.fathy.alfred.dbagent.transport.StatementSink;
import com.fathy.alfred.dbagent.transport.Value;
import com.fathy.alfred.dbagent.values.ValueCodec;

import java.lang.reflect.Method;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Everything the inlined advice calls (via {@link Bridge}). Every entry point is wrapped so an agent failure is counted
 * and swallowed - it must never surface in the application.
 *
 * <p>Wrapped JDBC objects (a pool's WrappedPreparedStatement around the driver's own) are both instrumented; a
 * per-thread depth counter means only the OUTERMOST execute/commit is recorded, which is the one the application
 * called. Inner objects never get a pending record, so their result sets and OUT parameters are ignored too.
 */
public final class CaptureDispatcher implements Bridge.Dispatcher {

    private static final Object NESTED = new Object();
    private static final Object SKIPPED = new Object();
    /** SQL Hibernate ran on its own outside any query or event tracked (a sequence's next value, a version check). */
    private static final OriginRecord HIBERNATE_INTERNAL = new OriginRecord();

    static {
        HIBERNATE_INTERNAL.id = "hibernate";
        HIBERNATE_INTERNAL.kind = "HIBERNATE";
    }
    static final String PARENT_HEADER = "X-Alfred-Parent";

    private final StatementSink sink;
    private final AgentSettings settings;
    private final String agentId;
    private final StatementInterceptor interceptor = new CaptureOnlyInterceptor();
    private final Recorder recorder;
    private final OriginTracker origins;
    private final AtomicLong sids = new AtomicLong();
    private final AtomicInteger outsideSeq = new AtomicInteger();
    private final WeakIdentityMap<StatementState> statements = new WeakIdentityMap<>();
    private final WeakIdentityMap<ResultCapture> resultSets = new WeakIdentityMap<>();
    private final WeakIdentityMap<ConnectionState> connections = new WeakIdentityMap<>();
    private final ThreadLocal<int[]> executeDepth = ThreadLocal.withInitial(() -> new int[1]);
    private final ThreadLocal<int[]> transactionDepth = ThreadLocal.withInitial(() -> new int[1]);
    private final ThreadLocal<int[]> acquireDepth = ThreadLocal.withInitial(() -> new int[1]);
    private final ThreadLocal<int[]> closeDepth = ThreadLocal.withInitial(() -> new int[1]);
    private final ThreadLocal<int[]> jtaDepth = ThreadLocal.withInitial(() -> new int[1]);
    /** Connections with a transaction begun on this thread and not ended - a JTA commit/rollback ends all of them. */
    private final ThreadLocal<List<ConnectionState>> openTransactions = ThreadLocal.withInitial(ArrayList::new);
    /**
     * Set while the agent itself talks to the driver (result-set metadata, the data-source name, a before-image read,
     * cascade metadata). Drivers answer some of those with JDBC queries of their own - pgjdbc looks column types up in
     * pg_type - and every hook must ignore them: recording them would be wrong, and reading THEIR metadata recursed
     * until the stack overflowed (found against a real PostgreSQL, VendorCaptureIT).
     */
    private final ThreadLocal<int[]> agentWork = ThreadLocal.withInitial(() -> new int[1]);
    private final ConcurrentHashMap<Class<?>, Method> headerGetters = new ConcurrentHashMap<>();
    /** The X-Alfred-Parent value given to each outbound connection/request object ("" = not ours to tag). */
    private final WeakIdentityMap<String> outboundTagged = new WeakIdentityMap<>();
    /** The header outboundOpened gave a connection - under the object the code holds AND, for HTTPS, the JDK's inner
     *  delegate, which is the object the connect/send hooks run on. */
    private final WeakIdentityMap<String> outboundOpenedHeaders = new WeakIdentityMap<>();

    /** Logging hooks entered on this thread - only the outermost one catches (bridges call one framework from another). */
    private final ThreadLocal<int[]> logDepth = ThreadLocal.withInitial(() -> new int[1]);
    private static final Object LOG_TOKEN = new Object();
    private final LogCatcher logCatcher;

    public CaptureDispatcher(StatementSink sink, AgentSettings settings, String agentId) {
        this.logCatcher = new LogCatcher(sink);
        this.sink = sink;
        this.settings = settings;
        this.agentId = agentId;
        this.recorder = new Recorder(sink);
        this.origins = new OriginTracker(agentId);
    }

    private boolean agentBusy() {
        return agentWork.get()[0] > 0;
    }

    private void beginAgentWork() {
        agentWork.get()[0]++;
    }

    private void endAgentWork() {
        agentWork.get()[0]--;
    }

    public void flushStale() {
        recorder.flushStale(System.nanoTime());
    }

    int pendingCount() {
        return recorder.pendingCount();
    }

    // ------------------------------------------------------------------ servlet and threads

    @Override
    public Object servletEnter(Object request) {
        try {
            if (ContextPropagation.current() != null) {
                return null; // a forward/include inside a call already tracked
            }
            String header = header(request, CallContext.HEADER);
            CallContext context = CallContext.fromHeader(header, System.nanoTime());
            // the request's log lines carry its call id while the project's log-linking switch is on (log=1), captured or not
            Object logRestore = LogTagger.tag(CallContext.logTagId(header));
            if (context == null) {
                return logRestore == null ? null : new Entered(null, logRestore);
            }
            ContextPropagation.set(context);
            sink.marker(new MarkerRecord(context.callId, 0, "CALL_OPEN", Instant.now().toString(), null, null, Thread.currentThread().getName(),
                    context.logs, context.logs ? settings.logLevelName() : null));
            return logRestore == null ? context : new Entered(context, logRestore);
        } catch (Throwable t) {
            AgentLog.failure("servlet entry", t);
            return null;
        }
    }

    @Override
    public void servletExit(Object token, Throwable thrown) {
        CallContext context = token instanceof Entered ? ((Entered) token).context : token instanceof CallContext ? (CallContext) token : null;
        try {
            if (context != null) {
                context.closedAtNanos = System.nanoTime();
                recorder.flushContext(context);
            }
        } catch (Throwable t) {
            AgentLog.failure("servlet exit", t);
        } finally {
            if (context != null) {
                ContextPropagation.set(null);
                openTransactions.get().clear(); // a transaction nobody ended by now never will be on this (pooled) thread
            }
            if (token instanceof Entered) {
                LogTagger.restore(((Entered) token).logRestore);
            }
        }
    }

    /** What servletEnter opened when the request's log lines were tagged too: the call (null when db=0) and the tag. */
    static final class Entered {
        final CallContext context;
        final Object logRestore;

        Entered(CallContext context, Object logRestore) {
            this.context = context;
            this.logRestore = logRestore;
        }
    }

    private String header(Object request, String name) throws Exception {
        Method getter = headerGetters.get(request.getClass());
        if (getter == null) {
            getter = request.getClass().getMethod("getHeader", String.class);
            getter.setAccessible(true);
            headerGetters.put(request.getClass(), getter);
        }
        return (String) getter.invoke(request, name);
    }

    @Override
    public Object wrapRunnable(Object runnable) {
        try {
            return ContextPropagation.wrapRunnable(runnable);
        } catch (Throwable t) {
            return runnable;
        }
    }

    @Override
    public Object wrapCallable(Object callable) {
        try {
            return ContextPropagation.wrapCallable(callable);
        } catch (Throwable t) {
            return callable;
        }
    }

    // ------------------------------------------------------------------ statements

    @Override
    public void statementCreated(Object connection, Object statement, String sql) {
        if (agentBusy()) {
            return;
        }
        try {
            if (statement != null) {
                statements.put(statement, new StatementState(connection, sql));
                connection(connection);
            }
        } catch (Throwable t) {
            AgentLog.failure("statement created", t);
        }
    }

    private StatementState state(Object statement) {
        StatementState state = statements.get(statement);
        if (state == null) {
            Object connection = null;
            try {
                connection = ((java.sql.Statement) statement).getConnection();
            } catch (Throwable ignored) {
                // a statement created before the agent attached, on a connection it cannot reach - no transaction info
            }
            state = new StatementState(connection, null);
            statements.put(statement, state);
        }
        return state;
    }

    private ConnectionState connection(Object connection) {
        if (connection == null) {
            return null;
        }
        ConnectionState state = connections.get(connection);
        if (state == null) {
            state = new ConnectionState("conn-" + Integer.toHexString(System.identityHashCode(connection)));
            connections.put(connection, state);
        }
        return state;
    }

    @Override
    public void parameter(Object statement, String method, Object[] args) {
        if (agentBusy()) {
            return;
        }
        try {
            if (args == null || args.length == 0) {
                return;
            }
            StatementState state = state(statement);
            synchronized (state) {
                if (method.equals("registerOutParameter")) {
                    if (!state.outParameters.contains(args[0])) {
                        state.outParameters.add(args[0]);
                    }
                    return;
                }
                state.current.put(args[0], ValueCodec.parameter(method, args));
                Object value = args.length > 1 && !method.equals("setNull") ? args[1] : null;
                if (value instanceof java.io.InputStream || value instanceof java.io.Reader) {
                    state.raw.remove(args[0]);
                } else {
                    state.raw.put(args[0], value);
                }
            }
        } catch (Throwable t) {
            AgentLog.failure("parameter", t);
        }
    }

    @Override
    public void addBatch(Object statement, Object[] args) {
        if (agentBusy()) {
            return;
        }
        try {
            StatementState state = state(statement);
            synchronized (state) {
                if (args != null && args.length == 1 && args[0] instanceof String) {
                    state.batchSqls.add((String) args[0]);
                } else {
                    state.batchSets.add(state.snapshot());
                }
            }
        } catch (Throwable t) {
            AgentLog.failure("addBatch", t);
        }
    }

    @Override
    public void clearParameters(Object statement) {
        if (agentBusy()) {
            return;
        }
        try {
            StatementState state = statements.get(statement);
            if (state != null) {
                synchronized (state) {
                    state.current.clear();
                    state.raw.clear();
                }
            }
        } catch (Throwable t) {
            AgentLog.failure("clearParameters", t);
        }
    }

    @Override
    public Object executeEnter(Object statement, String method, Object[] args) {
        int[] depth = executeDepth.get();
        depth[0]++;
        if (depth[0] > 1 || agentBusy()) {
            return NESTED;
        }
        try {
            CallContext context = ContextPropagation.current();
            if (!recordsStatements(context)) {
                return SKIPPED;
            }
            StatementState state = state(statement);
            recorder.finish(state.pending);
            state.pending = null;
            String sql = args != null && args.length > 0 && args[0] instanceof String ? (String) args[0] : state.sql;
            boolean batch = method.startsWith("executeBatch") || method.startsWith("executeLargeBatch");
            if (batch && sql == null && !state.batchSqls.isEmpty()) {
                sql = String.join(";\n", state.batchSqls);
            }
            if (sql == null || settings.ignored(sql)) {
                return SKIPPED;
            }
            long now = System.nanoTime();
            int seq = context != null ? context.nextSeq() : outsideSeq.incrementAndGet();
            interceptor.before(context == null ? null : context.callId, context == null ? null : context.runTag, seq, sql);

            StatementRecord record = new StatementRecord();
            Long acquireForNext = null;
            record.sid = agentId + ":" + sids.incrementAndGet();
            record.callId = context == null ? null : context.callId;
            record.runTag = context == null ? null : context.runTag;
            record.thread = Thread.currentThread().getName();
            record.seq = seq;
            record.sql = sql;
            record.kind = SqlShape.kind(sql);
            record.table = SqlShape.table(sql);
            List<List<Value>> params;
            synchronized (state) {
                if (batch && !state.batchSets.isEmpty()) {
                    params = new ArrayList<>(state.batchSets);
                    state.batchSets.clear();
                } else {
                    params = Collections.singletonList(state.snapshot());
                }
                state.batchSqls.clear();
            }
            record.params = params;
            record.fingerprint = SqlShape.fingerprint(sql, params.isEmpty() ? Collections.<Value>emptyList() : params.get(0));
            record.startedAt = Instant.now().toString();
            record.offsetMicros = context == null ? 0 : context.offsetMicros(now);
            CodeLocation.Where where = CodeLocation.find(settings.callerFrames(), settings.passThrough());
            record.codeLocation = where.location;
            record.callers = where.callers;
            record.origin = origins.current();
            if (record.origin == null && CodeLocation.sawHibernate()) {
                record.origin = HIBERNATE_INTERNAL;
            }
            ConnectionState conn = connection(state.connection);
            if (conn != null) {
                record.connectionId = conn.id;
                beginAgentWork();
                try {
                    record.dataSource = dataSource(conn, state.connection);
                    if (settings.indexInfo() && record.table != null && context != null && state.connection instanceof Connection
                            && context.firstIndexLookup(record.table)) {
                        record.indexes = IndexInspector.indexesOf((Connection) state.connection, record.dataSource, record.table);
                    }
                } finally {
                    endAgentWork();
                }
                if (!conn.autoCommit && !"COMMIT".equals(record.kind) && !"ROLLBACK".equals(record.kind)) {
                    if (conn.txId == null && context != null) {
                        conn.txId = context.nextTxId();
                        conn.txStartNanos = now;
                        conn.txContext = context;
                        conn.closeMicros = null;
                        openTransactions.get().add(conn);
                    } else if (conn.txId == null) {
                        conn.txId = "tx-o" + outsideSeq.incrementAndGet();
                        conn.txStartNanos = now;
                        conn.txContext = null;
                    }
                    record.txId = conn.txId;
                }
                Long acquire = conn.pendingAcquireMicros;
                if (acquire != null) {
                    conn.pendingAcquireMicros = null;
                    acquireForNext = acquire;
                }
            }
            if (!batch && state.connection instanceof Connection && ("DELETE".equals(record.kind) || "UPDATE".equals(record.kind))) {
                beginAgentWork();
                try {
                    beforeWrite(state, (Connection) state.connection, sql, record);
                } finally {
                    endAgentWork();
                }
            }
            // The statement's own time starts here - after any before-image read, which is reported on its own.
            Outcome initial = new Outcome("UPDATED");
            initial.acquireMicros = acquireForNext;
            PendingStatement pending = new PendingStatement(record, context, System.nanoTime(), initial);
            return new Execution(statement, state, pending, batch);
        } catch (Throwable t) {
            AgentLog.failure("execute", t);
            return SKIPPED;
        }
    }

    /**
     * Just before an UPDATE/DELETE runs: which tables a DELETE cascades into (metadata, cached per table) and, only for
     * tables the user opted in, the rows it is about to change (BeforeImageReader). Inside executeEnter, so the
     * agent's own queries come back as NESTED and are never recorded.
     */
    private void beforeWrite(StatementState state, Connection connection, String sql, StatementRecord record) {
        try {
            if ("DELETE".equals(record.kind)) {
                List<String> cascades = CascadeInspector.cascadesTo(connection, record.dataSource, record.table);
                if (!cascades.isEmpty()) {
                    record.cascadesTo = cascades;
                }
            }
            if (settings.beforeImageFor(record.table)) {
                Map<Object, Object> bound;
                synchronized (state) {
                    bound = new java.util.HashMap<>(state.raw);
                }
                List<List<Value>> rows = new ArrayList<>();
                record.beforeImage = BeforeImageReader.read(connection, sql, bound, settings.rowsPerResult(), rows);
                if (!rows.isEmpty()) {
                    record.beforeImageRows = rows;
                }
            }
        } catch (Throwable t) {
            AgentLog.failure("before-write", t);
        }
    }

    private String dataSource(ConnectionState conn, Object connection) {
        if (conn.dataSource == null && connection instanceof Connection) {
            try {
                DatabaseMetaData meta = ((Connection) connection).getMetaData();
                conn.dataSource = meta.getDatabaseProductName() + " " + meta.getDatabaseProductVersion();
            } catch (Throwable t) {
                conn.dataSource = "unknown";
            }
        }
        return conn.dataSource;
    }

    @Override
    public void executeExit(Object token, Object result, Throwable thrown) {
        executeDepth.get()[0]--;
        if (!(token instanceof Execution)) {
            return;
        }
        try {
            Execution e = (Execution) token;
            PendingStatement p = e.pending;
            p.base.durationMicros = (System.nanoTime() - p.startNanos) / 1000;
            if (thrown != null) {
                failed(p.outcome, thrown);
                recorder.track(p);
                recorder.finish(p);
                return;
            }
            if (result instanceof java.sql.ResultSet) {
                p.outcome.kind = "ROWS";
                resultSets.put(result, new ResultCapture(p, ResultCapture.Mode.ROWS, settings.rowsPerResult()));
            } else if (result instanceof int[]) {
                List<Long> perSet = new ArrayList<>();
                long total = 0;
                for (int n : (int[]) result) {
                    perSet.add((long) n);
                    total += Math.max(0, n);
                }
                p.outcome.perSet = perSet;
                p.outcome.affected = total;
            } else if (result instanceof long[]) {
                List<Long> perSet = new ArrayList<>();
                long total = 0;
                for (long n : (long[]) result) {
                    perSet.add(n);
                    total += Math.max(0, n);
                }
                p.outcome.perSet = perSet;
                p.outcome.affected = total;
            } else if (result instanceof Number) {
                p.outcome.affected = ((Number) result).longValue();
            } else if (Boolean.TRUE.equals(result)) {
                p.outcome.kind = "ROWS"; // execute() with a result: getResultSet() links it
            } else if (Boolean.FALSE.equals(result)) {
                try {
                    p.outcome.affected = (long) ((java.sql.Statement) e.statement).getUpdateCount();
                } catch (Throwable ignored) {
                    // the count is only informative
                }
            }
            if ("CALL".equals(p.base.kind) && !e.state.outParameters.isEmpty()) {
                p.outcome.kind = "PROCEDURE";
                p.outcome.outParams = new ArrayList<>();
            }
            e.state.pending = p;
            recorder.track(p);
        } catch (Throwable t) {
            AgentLog.failure("execute exit", t);
        }
    }

    private static void failed(Outcome outcome, Throwable thrown) {
        outcome.kind = "FAILED";
        Throwable t = thrown;
        if (t instanceof SQLException) {
            SQLException sql = (SQLException) t;
            outcome.sqlState = sql.getSQLState();
            outcome.vendorCode = sql.getErrorCode();
        }
        outcome.message = String.valueOf(t.getMessage());
        List<String> chain = new ArrayList<>();
        Throwable cause = t.getCause();
        while (cause != null && chain.size() < 5) {
            chain.add(cause.getClass().getName() + ": " + cause.getMessage());
            cause = cause.getCause();
        }
        if (t instanceof SQLException) {
            SQLException next = ((SQLException) t).getNextException();
            while (next != null && chain.size() < 10) {
                chain.add(next.getSQLState() + " " + next.getErrorCode() + ": " + next.getMessage());
                next = next.getNextException();
            }
        }
        outcome.chain = chain;
    }

    @Override
    public void resultSetOpened(Object statement, Object resultSet, String method) {
        if (agentBusy()) {
            return;
        }
        try {
            if (resultSet == null) {
                return;
            }
            StatementState state = statements.get(statement);
            PendingStatement p = state == null ? null : state.pending;
            if (p == null || p.finished) {
                return;
            }
            boolean keys = method.equals("getGeneratedKeys");
            if (!keys) {
                synchronized (p) {
                    p.outcome.kind = "PROCEDURE".equals(p.outcome.kind) ? "PROCEDURE" : "ROWS";
                }
            }
            resultSets.put(resultSet, new ResultCapture(p, keys ? ResultCapture.Mode.KEYS : ResultCapture.Mode.ROWS, settings.rowsPerResult()));
        } catch (Throwable t) {
            AgentLog.failure("result set", t);
        }
    }

    @Override
    public void outParameterRead(Object statement, Object[] args, Object value) {
        if (agentBusy()) {
            return;
        }
        try {
            StatementState state = statements.get(statement);
            PendingStatement p = state == null ? null : state.pending;
            if (p == null || args == null || args.length == 0 || !state.outParameters.contains(args[0])) {
                return;
            }
            synchronized (p) {
                if (p.outcome.outParams == null) {
                    p.outcome.outParams = new ArrayList<>();
                    p.outcome.kind = "PROCEDURE";
                }
                p.outcome.outParams.add(ValueCodec.column(null, null, value).withDirection("OUT"));
            }
        } catch (Throwable t) {
            AgentLog.failure("out parameter", t);
        }
    }

    @Override
    public void statementClosed(Object statement) {
        try {
            StatementState state = statements.remove(statement);
            if (state != null) {
                recorder.finish(state.pending);
            }
        } catch (Throwable t) {
            AgentLog.failure("statement close", t);
        }
    }

    // ------------------------------------------------------------------ result sets

    @Override
    public void resultSetNext(Object resultSet, boolean hasRow) {
        if (agentBusy()) {
            return;
        }
        beginAgentWork();
        try {
            try {
                ResultCapture capture = resultSets.get(resultSet);
                if (capture == null) {
                    return;
                }
                if (hasRow) {
                    capture.startRow(resultSet, recorder);
                } else {
                    capture.commitRow(recorder);
                    capture.exhausted = true;
                }
            } catch (Throwable t) {
                AgentLog.failure("next", t);
            }
        } finally {
            endAgentWork();
        }
    }

    @Override
    public void resultSetGet(Object resultSet, String method, Object[] args, Object value) {
        if (agentBusy()) {
            return;
        }
        beginAgentWork();
        try {
            try {
                if (args == null || args.length == 0) {
                    return;
                }
                ResultCapture capture = resultSets.get(resultSet);
                if (capture != null) {
                    capture.cell(resultSet, args[0], method, value);
                }
            } catch (Throwable t) {
                AgentLog.failure("get", t);
            }
        } finally {
            endAgentWork();
        }
    }

    @Override
    public void resultSetWasNull(Object resultSet, boolean wasNull) {
        if (agentBusy()) {
            return;
        }
        if (!wasNull) {
            return;
        }
        try {
            ResultCapture capture = resultSets.get(resultSet);
            if (capture != null) {
                capture.lastWasNull();
            }
        } catch (Throwable t) {
            AgentLog.failure("wasNull", t);
        }
    }

    @Override
    public void resultSetClosed(Object resultSet) {
        if (agentBusy()) {
            return;
        }
        beginAgentWork();
        try {
            try {
                ResultCapture capture = resultSets.remove(resultSet);
                if (capture == null) {
                    return;
                }
                capture.ensureColumns(resultSet);
                capture.commitRow(recorder);
                PendingStatement p = capture.pending;
                if (capture.mode == ResultCapture.Mode.KEYS) {
                    synchronized (p) {
                        p.outcome.generatedKeys = capture.keys;
                    }
                    return;
                }
                synchronized (p) {
                    p.outcome.partial = !capture.exhausted;
                }
                recorder.finish(p);
            } catch (Throwable t) {
                AgentLog.failure("result set close", t);
            }
        } finally {
            endAgentWork();
        }
    }

    // ------------------------------------------------------------------ transactions

    @Override
    public void autoCommit(Object connection, boolean autoCommit) {
        if (agentBusy()) {
            return;
        }
        try {
            ConnectionState conn = connection(connection);
            if (conn == null) {
                return;
            }
            if (autoCommit && !conn.autoCommit && conn.txId != null) {
                endTransaction(conn, "COMMIT", "COMMITTED", "JDBC", null); // JDBC: switching auto-commit on commits
            }
            conn.autoCommit = autoCommit;
        } catch (Throwable t) {
            AgentLog.failure("autoCommit", t);
        }
    }

    @Override
    public Object transactionEnter(Object connection, String method, Object[] args) {
        int[] depth = transactionDepth.get();
        depth[0]++;
        if (depth[0] > 1 || agentBusy()) {
            return NESTED;
        }
        return new TxCall(connection, method, args != null && args.length > 0, System.nanoTime());
    }

    @Override
    public void transactionExit(Object token, Throwable thrown) {
        transactionDepth.get()[0]--;
        if (!(token instanceof TxCall) || thrown != null) {
            return;
        }
        try {
            TxCall call = (TxCall) token;
            ConnectionState conn = connections.get(call.connection);
            if (conn == null || conn.txId == null) {
                return;
            }
            long micros = (System.nanoTime() - call.startNanos) / 1000;
            switch (call.method) {
                case "commit":
                    endTransaction(conn, "COMMIT", "COMMITTED", "JDBC", micros);
                    break;
                case "rollback":
                    if (call.hasArgs) {
                        marker(conn, "ROLLBACK_TO_SAVEPOINT", "ROLLBACK TO SAVEPOINT", "ROLLED_BACK_TO_SAVEPOINT", null, null);
                    } else {
                        endTransaction(conn, "ROLLBACK", "ROLLED_BACK", "JDBC", micros);
                    }
                    break;
                case "setSavepoint":
                    marker(conn, "SAVEPOINT", "SAVEPOINT", "SAVEPOINT", null, null);
                    break;
                default:
                    break;
            }
        } catch (Throwable t) {
            AgentLog.failure("transaction", t);
        }
    }

    private void endTransaction(ConnectionState conn, String kind, String result, String via, Long commitMicros) {
        marker(conn, kind, kind, result, via, commitMicros);
        conn.txId = null;
        conn.txContext = null;
        conn.beginMicros = null;
        conn.closeMicros = null;
        openTransactions.get().remove(conn);
    }

    /** A COMMIT/ROLLBACK/SAVEPOINT shown as its own statement line, in the transaction it ends. */
    private void marker(ConnectionState conn, String kind, String sql, String result, String via, Long commitMicros) {
        CallContext context = conn.txContext != null ? conn.txContext : ContextPropagation.current();
        if (!recordsStatements(context)) {
            return;
        }
        long now = System.nanoTime();
        StatementRecord record = new StatementRecord();
        record.sid = agentId + ":" + sids.incrementAndGet();
        record.callId = context == null ? null : context.callId;
        record.runTag = context == null ? null : context.runTag;
        record.thread = Thread.currentThread().getName();
        record.seq = context != null ? context.nextSeq() : outsideSeq.incrementAndGet();
        record.kind = kind;
        record.sql = sql;
        record.fingerprint = SqlShape.fingerprint(sql, Collections.<Value>emptyList());
        record.params = Collections.emptyList();
        record.startedAt = Instant.now().toString();
        record.offsetMicros = context == null ? 0 : context.offsetMicros(now);
        record.txId = conn.txId;
        record.connectionId = conn.id;
        record.dataSource = conn.dataSource;
        Outcome outcome = new Outcome("TX_END");
        outcome.txResult = result;
        outcome.heldMicros = (now - conn.txStartNanos) / 1000;
        if (via != null) {
            outcome.via = via;
            outcome.commitMicros = commitMicros;
            outcome.beginMicros = conn.beginMicros;
            outcome.closeMicros = conn.closeMicros;
        }
        record.outcome = outcome;
        PendingStatement p = new PendingStatement(record, context, now, outcome);
        recorder.track(p);
        recorder.finish(p);
    }

    // ------------------------------------------------------------------ Hibernate / JPA

    private boolean originsWanted() {
        return !agentBusy() && recordsStatements(ContextPropagation.current());
    }

    /**
     * Statements are recorded for a call with capture on (db=1), and outside any call when the project asks for it -
     * never for a logs-only call (db=0; log=1), which is neither.
     */
    private boolean recordsStatements(CallContext context) {
        return context != null ? context.capture : settings.captureOutsideCalls();
    }

    @Override
    public Object queryEnter(Object query, String method) {
        if (!originsWanted()) {
            return null;
        }
        try {
            return origins.queryEnter(query, method);
        } catch (Throwable t) {
            AgentLog.failure("query", t);
            return null;
        }
    }

    @Override
    public void queryParameter(Object query, String method, Object[] args) {
        if (!originsWanted()) {
            return;
        }
        try {
            origins.parameter(query, method, args);
        } catch (Throwable t) {
            AgentLog.failure("query parameter", t);
        }
    }

    @Override
    public void queryNamed(Object query, String name) {
        if (!originsWanted()) {
            return;
        }
        try {
            origins.named(query, name);
        } catch (Throwable t) {
            AgentLog.failure("named query", t);
        }
    }

    @Override
    public Object hibernateEventEnter(String type, Object self, Object[] args) {
        if (!originsWanted()) {
            return null;
        }
        beginAgentWork();
        try {
            return origins.eventEnter(type, self, args);
        } catch (Throwable t) {
            AgentLog.failure("hibernate event", t);
            return null;
        } finally {
            endAgentWork();
        }
    }

    @Override
    public void originExit(Object token) {
        try {
            origins.exit(token);
        } catch (Throwable t) {
            AgentLog.failure("origin exit", t);
        }
    }

    // ------------------------------------------------------------------ connection lifecycle

    @Override
    public void autoCommitDone(Object connection, long nanos) {
        if (agentBusy()) {
            return;
        }
        try {
            ConnectionState conn = connections.get(connection);
            if (conn != null) {
                conn.beginMicros = nanos / 1000;
            }
        } catch (Throwable t) {
            AgentLog.failure("autoCommit timing", t);
        }
    }

    @Override
    public Object acquireEnter() {
        int[] depth = acquireDepth.get();
        depth[0]++;
        if (depth[0] > 1 || agentBusy()) {
            return NESTED;
        }
        return new long[]{System.nanoTime()};
    }

    @Override
    public void acquireExit(Object token, Object connection) {
        acquireDepth.get()[0]--;
        if (!(token instanceof long[]) || connection == null) {
            return;
        }
        try {
            if (!recordsStatements(ContextPropagation.current())) {
                return;
            }
            ConnectionState conn = connection(connection);
            if (conn != null) {
                conn.pendingAcquireMicros = (System.nanoTime() - ((long[]) token)[0]) / 1000;
            }
        } catch (Throwable t) {
            AgentLog.failure("getConnection", t);
        }
    }

    @Override
    public Object closeEnter(Object connection) {
        int[] depth = closeDepth.get();
        depth[0]++;
        if (depth[0] > 1 || agentBusy()) {
            return NESTED;
        }
        return new CloseCall(connection, System.nanoTime());
    }

    @Override
    public void closeExit(Object token) {
        closeDepth.get()[0]--;
        if (!(token instanceof CloseCall)) {
            return;
        }
        try {
            CloseCall call = (CloseCall) token;
            ConnectionState conn = connections.get(call.connection);
            if (conn != null && conn.txId != null) {
                conn.closeMicros = (System.nanoTime() - call.startNanos) / 1000; // reported when its transaction ends
            }
        } catch (Throwable t) {
            AgentLog.failure("close", t);
        }
    }

    @Override
    public Object jtaEnter(String method) {
        int[] depth = jtaDepth.get();
        depth[0]++;
        if (depth[0] > 1 || agentBusy() || openTransactions.get().isEmpty()) {
            return NESTED;
        }
        return new TxCall(null, method, false, System.nanoTime());
    }

    /** The container committed (or rolled back): every transaction this thread had open ends with it. */
    @Override
    public void jtaExit(Object token, Throwable thrown) {
        jtaDepth.get()[0]--;
        if (!(token instanceof TxCall)) {
            return;
        }
        try {
            TxCall call = (TxCall) token;
            long micros = (System.nanoTime() - call.startNanos) / 1000;
            boolean committed = "commit".equals(call.method) && thrown == null;
            for (ConnectionState conn : new ArrayList<>(openTransactions.get())) {
                if (conn.txId != null) {
                    endTransaction(conn, committed ? "COMMIT" : "ROLLBACK", committed ? "COMMITTED" : "ROLLED_BACK", "JTA", micros);
                }
            }
            openTransactions.get().clear();
        } catch (Throwable t) {
            AgentLog.failure("jta", t);
        }
    }

    // ------------------------------------------------------------------ logging (specs/009-agent-log-capture)

    @Override
    public Object logEnter(String type, Object self, Object event) {
        int[] depth = logDepth.get();
        depth[0]++;
        if (depth[0] > 1 || agentBusy()) {
            return LOG_TOKEN;
        }
        try {
            CallContext context = ContextPropagation.current();
            boolean outside = settings.logsOutside();
            if (context == null ? !outside : !context.logs) {
                return LOG_TOKEN;
            }
            String kind = LogCatcher.kindOf(type);
            if (kind == null || ("jul".equals(kind) && !LogCatcher.julLoggable(self, event))) {
                return LOG_TOKEN;
            }
            beginAgentWork();
            try {
                logCatcher.caught(kind, event, context, outside, settings.logMinRank());
            } finally {
                endAgentWork();
            }
        } catch (Throwable t) {
            AgentLog.failure("log catching", t);
        }
        return LOG_TOKEN;
    }

    @Override
    public void logExit(Object token) {
        logDepth.get()[0]--;
    }

    // ------------------------------------------------------------------ outbound HTTP

    @Override
    public String outboundHeader(String method, String url) {
        try {
            CallContext context = ContextPropagation.current();
            if (context == null) {
                return null;
            }
            int seq = context.nextSeq();
            sink.marker(new MarkerRecord(context.callId, seq, "HTTP_OUT", Instant.now().toString(), method, withoutQuery(url)));
            return context.callId + "; seq=" + seq;
        } catch (Throwable t) {
            AgentLog.failure("outbound header", t);
            return null;
        }
    }

    @Override
    public void outboundOpened(Object connection) {
        try {
            CallContext context = ContextPropagation.current();
            if (context == null) {
                return;
            }
            java.net.HttpURLConnection http = (java.net.HttpURLConnection) connection;
            String protocol = http.getURL().getProtocol();
            if (!"http".equals(protocol) && !"https".equals(protocol)) {
                return;
            }
            // The sequence number is taken now; the HTTP_OUT marker is recorded at the first connect/send hook,
            // when the method is known (outboundHeaderFor finds this header and reuses its seq).
            String header = context.callId + "; seq=" + context.nextSeq();
            http.setRequestProperty(PARENT_HEADER, header);
            outboundOpenedHeaders.put(connection, header);
            Object delegate = httpsDelegate(connection);
            if (delegate != null) {
                outboundOpenedHeaders.put(delegate, header);
            }
        } catch (Throwable t) {
            AgentLog.failure("outbound open", t);
        }
    }

    @Override
    public String outboundHeaderFor(Object connection, String method, String url) {
        try {
            String known = outboundTagged.get(connection);
            if (known != null) {
                return known.isEmpty() ? null : known;
            }
            CallContext context = ContextPropagation.current();
            if (context == null) {
                return null;
            }
            String opened = outboundOpenedHeaders.remove(connection);
            if (opened == null || !opened.startsWith(context.callId + "; seq=")) {
                opened = openedHeader(connection, context);
            }
            if (opened != null) {
                int seq = Integer.parseInt(opened.substring(opened.lastIndexOf('=') + 1).trim());
                sink.marker(new MarkerRecord(context.callId, seq, "HTTP_OUT", Instant.now().toString(), method, withoutQuery(url)));
                outboundTagged.put(connection, opened);
                return opened;
            }
            String header = outboundHeader(method, url);
            outboundTagged.put(connection, header == null ? "" : header);
            return header;
        } catch (Throwable t) {
            AgentLog.failure("outbound header", t);
            return null;
        }
    }

    /** sun.net.www.protocol.https.HttpsURLConnectionImpl wraps the connection the hooks see in a "delegate" field. */
    private static Object httpsDelegate(Object connection) {
        for (Class<?> c = connection.getClass(); c != null && c != Object.class; c = c.getSuperclass()) {
            try {
                java.lang.reflect.Field f = c.getDeclaredField("delegate");
                f.setAccessible(true);
                return f.get(connection);
            } catch (NoSuchFieldException next) {
                // superclass
            } catch (Throwable t) {
                return null; // Java 9+ module rules may refuse; the getRequestProperty fallback remains
            }
        }
        return null;
    }

    /** The header outboundOpened put on this connection for this call, if it did. */
    private static String openedHeader(Object connection, CallContext context) {
        if (!(connection instanceof java.net.HttpURLConnection)) {
            return null;
        }
        String value;
        try {
            value = ((java.net.HttpURLConnection) connection).getRequestProperty(PARENT_HEADER);
        } catch (IllegalStateException connected) {
            return null;
        }
        return value != null && value.startsWith(context.callId + "; seq=") ? value : null;
    }

    @Override
    public void tagHttpClientRequest(Object request) {
        try {
            if (request == null || ContextPropagation.current() == null) {
                return;
            }
            Class<?> type = request.getClass();
            Method contains = findMethod(type, "containsHeader", 1);
            if (contains != null && Boolean.TRUE.equals(contains.invoke(request, PARENT_HEADER))) {
                return;
            }
            Method add = findMethod(type, "addHeader", 2);
            if (add == null) {
                return;
            }
            if (outboundTagged.get(request) != null) {
                return; // tagged already, though the client did not keep the header where containsHeader looks
            }
            String[] methodAndUrl = methodAndUrl(request);
            String header = outboundHeaderFor(request, methodAndUrl[0], methodAndUrl[1]);
            if (header != null) {
                add.invoke(request, PARENT_HEADER, header);
            }
        } catch (Throwable t) {
            AgentLog.failure("http client", t);
        }
    }

    private static String[] methodAndUrl(Object request) throws Exception {
        Method getMethod = findMethod(request.getClass(), "getMethod", 0);
        Method getUri = findMethod(request.getClass(), "getUri", 0);
        if (getMethod != null && getUri != null) {
            return new String[]{String.valueOf(getMethod.invoke(request)), String.valueOf(getUri.invoke(request))};
        }
        Method line = findMethod(request.getClass(), "getRequestLine", 0);
        if (line != null) {
            Object requestLine = line.invoke(request);
            Method m = findMethod(requestLine.getClass(), "getMethod", 0);
            Method u = findMethod(requestLine.getClass(), "getUri", 0);
            return new String[]{String.valueOf(m.invoke(requestLine)), String.valueOf(u.invoke(requestLine))};
        }
        return new String[]{null, null};
    }

    private static Method findMethod(Class<?> type, String name, int params) {
        for (Method m : type.getMethods()) {
            if (m.getName().equals(name) && m.getParameterTypes().length == params
                    && (params == 0 || m.getParameterTypes()[0] == String.class)) {
                m.setAccessible(true);
                return m;
            }
        }
        return null;
    }

    static String withoutQuery(String url) {
        if (url == null) {
            return null;
        }
        int q = url.indexOf('?');
        return q < 0 ? url : url.substring(0, q);
    }

    private static final class Execution {
        final Object statement;
        final StatementState state;
        final PendingStatement pending;
        final boolean batch;

        Execution(Object statement, StatementState state, PendingStatement pending, boolean batch) {
            this.statement = statement;
            this.state = state;
            this.pending = pending;
            this.batch = batch;
        }
    }

    private static final class TxCall {
        final Object connection;
        final String method;
        final boolean hasArgs;
        final long startNanos;

        TxCall(Object connection, String method, boolean hasArgs, long startNanos) {
            this.connection = connection;
            this.method = method;
            this.hasArgs = hasArgs;
            this.startNanos = startNanos;
        }
    }

    private static final class CloseCall {
        final Object connection;
        final long startNanos;

        CloseCall(Object connection, long startNanos) {
            this.connection = connection;
            this.startNanos = startNanos;
        }
    }
}
