package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.capture.CaptureDispatcher;
import com.fathy.alfred.dbagent.transport.AgentSettings;
import com.fathy.alfred.dbagent.transport.MarkerRecord;
import com.fathy.alfred.dbagent.transport.StatementRecord;
import com.fathy.alfred.dbagent.transport.StatementSink;
import net.bytebuddy.agent.ByteBuddyAgent;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Installs the real agent into the test JVM once (ByteBuddy self-attach - the same Attach-API path
 * wildfly-proxy-toggle uses against WildFly), with a collecting sink instead of the HTTP sender. Calls are opened
 * exactly as in production: through HttpServlet.service with the X-Alfred-Call header the reverse proxy adds.
 */
public final class AgentTestSupport {

    public static final CollectingSink SINK = new CollectingSink();
    public static final AgentSettings SETTINGS = new AgentSettings();
    public static final CaptureDispatcher DISPATCHER;

    static {
        try {
            usedBeforeAttach();
            Instrumentation instrumentation = ByteBuddyAgent.install();
            AlfredDbAgent.injectBootstrap(instrumentation);
            DISPATCHER = AgentRuntime.install(instrumentation, SINK, SETTINGS, "test");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private AgentTestSupport() {
    }

    /**
     * The production case is attaching to a server that has been running for hours: its driver classes are long loaded.
     * Using H2 (and a thread pool) before the agent installs makes every test exercise that retransformation path -
     * the one that once missed a driver's ResultSet, loaded while its Statement was being retransformed.
     */
    private static void usedBeforeAttach() throws Exception {
        try (java.sql.Connection c = java.sql.DriverManager.getConnection("jdbc:h2:mem:preload");
             java.sql.PreparedStatement ps = c.prepareStatement("SELECT 1");
             java.sql.ResultSet rs = ps.executeQuery()) {
            rs.next();
        }
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newSingleThreadExecutor();
        // Not a lambda: its body would live in this class, whose initialiser is running right now - the pool
        // thread would wait on that initialisation forever.
        pool.submit(new Runnable() {
            @Override
            public void run() {
            }
        }).get();
        pool.shutdown();
    }

    public static void reset() {
        SETTINGS.apply(AgentSettings.DEFAULT_ROWS_PER_RESULT, Collections.emptySet(), false, false, Collections.singletonList("SELECT 1"));
        SETTINGS.applyLogs(false);
        SINK.clear();
    }

    /** Runs {@code body} inside a captured inbound call, through the instrumented servlet entry. */
    public static void inCall(String header, ThrowingRunnable body) throws Exception {
        Object request = Proxy.newProxyInstance(AgentTestSupport.class.getClassLoader(), new Class<?>[]{HttpServletRequest.class},
                (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "getHeader":
                            return "X-Alfred-Call".equalsIgnoreCase((String) args[0]) ? header : null;
                        case "getMethod":
                            return "GET";
                        case "getProtocol":
                            return "HTTP/1.1";
                        default:
                            return method.getReturnType() == boolean.class ? false : method.getReturnType() == int.class ? 0 : null;
                    }
                });
        Object response = Proxy.newProxyInstance(AgentTestSupport.class.getClassLoader(), new Class<?>[]{HttpServletResponse.class},
                (proxy, method, args) -> method.getReturnType() == boolean.class ? false : method.getReturnType() == int.class ? 0 : null);
        Exception[] failure = {null};
        new HttpServlet() {
            @Override
            protected void doGet(HttpServletRequest req, HttpServletResponse resp) {
                try {
                    body.run();
                } catch (Exception e) {
                    failure[0] = e;
                }
            }
        }.service((javax.servlet.ServletRequest) request, (javax.servlet.ServletResponse) response);
        if (failure[0] != null) {
            throw failure[0];
        }
    }

    public static void inCall(String callId, ThrowingRunnable body, boolean db) throws Exception {
        inCall("id=" + callId + "; db=" + (db ? 1 : 0), body);
    }

    public interface ThrowingRunnable {
        void run() throws Exception;
    }

    public static final class CollectingSink implements StatementSink {
        private final List<StatementRecord> statements = new ArrayList<>();
        private final List<MarkerRecord> markers = new ArrayList<>();
        private final List<com.fathy.alfred.dbagent.transport.LogRecord> logs = new ArrayList<>();
        private final java.util.Map<String, Integer> droppedLogs = new java.util.HashMap<>();

        @Override
        public synchronized void log(com.fathy.alfred.dbagent.transport.LogRecord record) {
            logs.add(record);
        }

        @Override
        public synchronized void droppedLogs(String callId, int count) {
            droppedLogs.merge(String.valueOf(callId), count, Integer::sum);
        }

        public synchronized List<com.fathy.alfred.dbagent.transport.LogRecord> logs() {
            return new ArrayList<>(logs);
        }

        public synchronized int droppedLogsOf(String callId) {
            return droppedLogs.getOrDefault(callId, 0);
        }

        @Override
        public synchronized void statement(StatementRecord record) {
            statements.add(record);
        }

        @Override
        public synchronized void marker(MarkerRecord marker) {
            markers.add(marker);
        }

        public synchronized List<StatementRecord> statements() {
            return new ArrayList<>(statements);
        }

        public synchronized List<StatementRecord> statementsOf(String callId) {
            return statements.stream().filter(s -> callId.equals(s.callId)).collect(Collectors.toList());
        }

        public synchronized List<MarkerRecord> markers() {
            return new ArrayList<>(markers);
        }

        synchronized void clear() {
            statements.clear();
            markers.clear();
            logs.clear();
            droppedLogs.clear();
        }
    }
}
