package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.AgentLog;
import com.fathy.alfred.dbagent.bootstrap.Bridge;
import com.fathy.alfred.dbagent.jdbc.BeforeImageReader;
import com.fathy.alfred.dbagent.jdbc.CaptureOnlyInterceptor;
import com.fathy.alfred.dbagent.jdbc.CascadeInspector;
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

    public CaptureDispatcher(StatementSink sink, AgentSettings settings, String agentId) {
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
            CallContext context = CallContext.fromHeader(header(request, CallContext.HEADER), System.nanoTime());
            if (context == null) {
                return null;
            }
            ContextPropagation.set(context);
            sink.marker(new MarkerRecord(context.callId, 0, "CALL_OPEN", Instant.now().toString(), null, null));
            return context;
        } catch (Throwable t) {
            AgentLog.failure("servlet entry", t);
            return null;
        }
    }

    @Override
    public void servletExit(Object token, Throwable thrown) {
        try {
            if (token instanceof CallContext) {
                recorder.flushContext((CallContext) token);
            }
        } catch (Throwable t) {
            AgentLog.failure("servlet exit", t);
        } finally {
            if (token instanceof CallContext) {
                ContextPropagation.set(null);
            }
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
            if (context == null && !settings.captureOutsideCalls()) {
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
            record.codeLocation = CodeLocation.find();
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
                } finally {
                    endAgentWork();
                }
                if (!conn.autoCommit && !"COMMIT".equals(record.kind) && !"ROLLBACK".equals(record.kind)) {
                    if (conn.txId == null && context != null) {
                        conn.txId = context.nextTxId();
                        conn.txStartNanos = now;
                        conn.txContext = context;
                    } else if (conn.txId == null) {
                        conn.txId = "tx-o" + outsideSeq.incrementAndGet();
                        conn.txStartNanos = now;
                        conn.txContext = null;
                    }
                    record.txId = conn.txId;
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
            PendingStatement pending = new PendingStatement(record, context, System.nanoTime(), new Outcome("UPDATED"));
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
                endTransaction(conn, "COMMIT", "COMMITTED"); // JDBC: switching auto-commit on commits
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
        return new TxCall(connection, method, args != null && args.length > 0);
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
            switch (call.method) {
                case "commit":
                    endTransaction(conn, "COMMIT", "COMMITTED");
                    break;
                case "rollback":
                    if (call.hasArgs) {
                        marker(conn, "ROLLBACK_TO_SAVEPOINT", "ROLLBACK TO SAVEPOINT", "ROLLED_BACK_TO_SAVEPOINT");
                    } else {
                        endTransaction(conn, "ROLLBACK", "ROLLED_BACK");
                    }
                    break;
                case "setSavepoint":
                    marker(conn, "SAVEPOINT", "SAVEPOINT", "SAVEPOINT");
                    break;
                default:
                    break;
            }
        } catch (Throwable t) {
            AgentLog.failure("transaction", t);
        }
    }

    private void endTransaction(ConnectionState conn, String kind, String result) {
        marker(conn, kind, kind, result);
        conn.txId = null;
        conn.txContext = null;
    }

    /** A COMMIT/ROLLBACK/SAVEPOINT shown as its own statement line, in the transaction it ends. */
    private void marker(ConnectionState conn, String kind, String sql, String result) {
        CallContext context = conn.txContext != null ? conn.txContext : ContextPropagation.current();
        if (context == null && !settings.captureOutsideCalls()) {
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
        record.outcome = outcome;
        PendingStatement p = new PendingStatement(record, context, now, outcome);
        recorder.track(p);
        recorder.finish(p);
    }

    // ------------------------------------------------------------------ Hibernate / JPA

    private boolean originsWanted() {
        return !agentBusy() && (ContextPropagation.current() != null || settings.captureOutsideCalls());
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
    public String outboundHeaderFor(Object connection, String method, String url) {
        try {
            String known = outboundTagged.get(connection);
            if (known != null) {
                return known.isEmpty() ? null : known;
            }
            if (ContextPropagation.current() == null) {
                return null;
            }
            String header = outboundHeader(method, url);
            outboundTagged.put(connection, header == null ? "" : header);
            return header;
        } catch (Throwable t) {
            AgentLog.failure("outbound header", t);
            return null;
        }
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

        TxCall(Object connection, String method, boolean hasArgs) {
            this.connection = connection;
            this.method = method;
            this.hasArgs = hasArgs;
        }
    }
}
