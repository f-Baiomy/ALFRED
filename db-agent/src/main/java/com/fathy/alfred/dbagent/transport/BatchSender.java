package com.fathy.alfred.dbagent.transport;

import com.fathy.alfred.dbagent.AgentLog;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Ships captured records to ALFRED without ever making the application wait (FR-005, research D6).
 *
 * <p>The application thread only {@link #statement offers} to a bounded queue; when it is full (20,000 records or
 * 64 MB) the record is dropped and counted per call, and the counts travel with the next batch. One daemon thread
 * drains it every 250 ms (or as soon as 500 records wait), posts batches of up to 2,000 statements, retries once, then
 * drops - a backend that is down costs the application nothing. The same thread sends the heartbeat every 10 s and
 * applies the settings it gets back, and runs {@code onTick} (stale pending statements are flushed there).
 */
public final class BatchSender implements StatementSink {

    static final int MAX_QUEUED = 20_000;
    static final long MAX_QUEUED_BYTES = 64L * 1024 * 1024;
    static final int MAX_STATEMENTS_PER_BATCH = 2_000;
    static final int MAX_MARKERS_PER_BATCH = 4_000;
    static final int MAX_LOGS_PER_BATCH = 5_000;
    static final long FLUSH_EVERY_MILLIS = 250;
    static final int FLUSH_AT = 500;
    static final long HEARTBEAT_EVERY_MILLIS = 10_000;
    private static final String OUTSIDE = "";

    private final String baseUrl;
    private final String secret;
    private final String project;
    private final String agentId;
    private final String agentVersion;
    private final AgentSettings settings;
    private final Runnable onTick;
    private final LinkedBlockingQueue<Object> queue = new LinkedBlockingQueue<>(MAX_QUEUED);
    private final AtomicLong queuedBytes = new AtomicLong();
    private final AtomicLong droppedTotal = new AtomicLong();
    private final ConcurrentHashMap<String, AtomicLong> droppedByCall = new ConcurrentHashMap<>();
    /** Log lines not kept, per call (queue full, caps, late) - travel with the next batch (FR-007, FR-008). */
    private final ConcurrentHashMap<String, AtomicLong> droppedLogsByCall = new ConcurrentHashMap<>();
    private volatile boolean running = true;
    private long lastHeartbeat;
    private Thread thread;

    public BatchSender(String baseUrl, String secret, String project, String agentId, String agentVersion, AgentSettings settings, Runnable onTick) {
        this.baseUrl = baseUrl;
        this.secret = secret;
        this.project = project;
        this.agentId = agentId;
        this.agentVersion = agentVersion;
        this.settings = settings;
        this.onTick = onTick;
    }

    public void start() {
        thread = new Thread(this::loop, "alfred-db-agent-sender");
        thread.setDaemon(true);
        thread.start();
    }

    public void stop() {
        running = false;
        if (thread != null) {
            thread.interrupt();
        }
    }

    @Override
    public void statement(StatementRecord record) {
        long bytes = record.approxBytes();
        if (queuedBytes.get() + bytes > MAX_QUEUED_BYTES || !queue.offer(record)) {
            drop(record.callId);
            return;
        }
        queuedBytes.addAndGet(bytes);
    }

    @Override
    public void marker(MarkerRecord marker) {
        if (!queue.offer(marker)) {
            drop(marker.callId);
        }
    }

    @Override
    public void log(LogRecord record) {
        long bytes = record.approxBytes();
        if (queuedBytes.get() + bytes > MAX_QUEUED_BYTES || !queue.offer(record)) {
            droppedLogs(record.callId, 1);
            return;
        }
        queuedBytes.addAndGet(bytes);
    }

    @Override
    public void droppedLogs(String callId, int count) {
        if (count > 0) {
            droppedLogsByCall.computeIfAbsent(callId == null ? OUTSIDE : callId, k -> new AtomicLong()).addAndGet(count);
        }
    }

    private void drop(String callId) {
        droppedTotal.incrementAndGet();
        droppedByCall.computeIfAbsent(callId == null ? OUTSIDE : callId, k -> new AtomicLong()).incrementAndGet();
    }

    long droppedTotal() {
        return droppedTotal.get();
    }

    int queued() {
        return queue.size();
    }

    private void loop() {
        heartbeat();
        while (running) {
            try {
                Object first = queue.poll(FLUSH_EVERY_MILLIS, TimeUnit.MILLISECONDS);
                runTick();
                if (first != null) {
                    List<Object> drained = new ArrayList<>();
                    drained.add(first);
                    if (queue.size() < FLUSH_AT) {
                        Thread.sleep(FLUSH_EVERY_MILLIS);
                    }
                    drainInto(drained);
                    send(drained);
                }
                if (System.currentTimeMillis() - lastHeartbeat >= HEARTBEAT_EVERY_MILLIS) {
                    heartbeat();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            } catch (Throwable t) {
                AgentLog.failure("sender", t);
            }
        }
    }

    private void runTick() {
        try {
            onTick.run();
        } catch (Throwable t) {
            AgentLog.failure("flush", t);
        }
    }

    private void drainInto(List<Object> drained) {
        int statements = 0;
        int markers = 0;
        int logs = 0;
        for (Object o : drained) {
            if (o instanceof StatementRecord) {
                statements++;
            } else if (o instanceof LogRecord) {
                logs++;
            } else {
                markers++;
            }
        }
        while (statements < MAX_STATEMENTS_PER_BATCH && markers < MAX_MARKERS_PER_BATCH && logs < MAX_LOGS_PER_BATCH) {
            Object next = queue.poll();
            if (next == null) {
                return;
            }
            drained.add(next);
            if (next instanceof StatementRecord) {
                statements++;
            } else if (next instanceof LogRecord) {
                logs++;
            } else {
                markers++;
            }
        }
    }

    /** Visible for the tests: one batch, posted now. */
    void send(List<Object> drained) {
        List<StatementRecord> statements = new ArrayList<>();
        List<MarkerRecord> markers = new ArrayList<>();
        List<LogRecord> logs = new ArrayList<>();
        for (Object o : drained) {
            if (o instanceof StatementRecord) {
                StatementRecord s = (StatementRecord) o;
                queuedBytes.addAndGet(-s.approxBytes());
                statements.add(s);
            } else if (o instanceof LogRecord) {
                LogRecord l = (LogRecord) o;
                queuedBytes.addAndGet(-l.approxBytes());
                logs.add(l);
            } else {
                markers.add((MarkerRecord) o);
            }
        }
        Map<String, Long> dropped = takeDropped();
        Map<String, Long> droppedLogs = take(droppedLogsByCall);
        String body = BatchWriter.write(agentId, project, statements, markers, dropped, logs, droppedLogs);
        if (post("/db-capture/agent/batch", body) == null) {
            sleepQuietly(1000);
            if (post("/db-capture/agent/batch", body) == null) {
                droppedTotal.addAndGet(statements.size());
                AgentLog.warn("ALFRED did not accept a batch - captured statements are being dropped (the application is unaffected)");
            }
        }
    }

    private static Map<String, Long> take(ConcurrentHashMap<String, AtomicLong> counts) {
        Map<String, Long> out = new HashMap<>();
        for (Map.Entry<String, AtomicLong> e : counts.entrySet()) {
            long n = e.getValue().getAndSet(0);
            if (n > 0 && !e.getKey().equals(OUTSIDE)) {
                out.put(e.getKey(), n);
            }
        }
        return out;
    }

    private Map<String, Long> takeDropped() {
        Map<String, Long> out = new HashMap<>();
        for (Map.Entry<String, AtomicLong> e : droppedByCall.entrySet()) {
            long n = e.getValue().getAndSet(0);
            if (n > 0 && !e.getKey().equals(OUTSIDE)) {
                out.put(e.getKey(), n);
            }
        }
        return out;
    }

    void heartbeat() {
        lastHeartbeat = System.currentTimeMillis();
        JsonWriter w = new JsonWriter().beginObject().name("agentId").value(agentId).name("project").value(project)
                .name("agentVersion").value(agentVersion)
                .name("jvm").value(System.getProperty("java.vm.name", "") + " " + System.getProperty("java.version", ""))
                .field("appServer", appServer())
                .name("droppedSinceStart").value(droppedTotal.get()).name("queuedStatements").value(queue.size()).endObject();
        String answer = post("/db-capture/agent/heartbeat", w.toString());
        if (answer != null) {
            applySettings(answer);
        }
    }

    @SuppressWarnings("unchecked")
    void applySettings(String json) {
        try {
            Map<String, Object> map = (Map<String, Object>) MiniJson.parse(json);
            Object rows = map.get("rowsPerResult");
            List<Object> tables = (List<Object>) map.get("beforeImageTables");
            List<Object> ignore = (List<Object>) map.get("ignorePatterns");
            List<String> ignoreStrings = new ArrayList<>();
            if (ignore != null) {
                for (Object o : ignore) {
                    ignoreStrings.add(String.valueOf(o));
                }
            }
            HashSet<String> tableSet = new HashSet<>();
            if (tables != null) {
                for (Object o : tables) {
                    tableSet.add(String.valueOf(o));
                }
            }
            List<String> passThrough = new ArrayList<>();
            Object pass = map.get("passThroughClasses");
            if (pass instanceof List) {
                for (Object o : (List<Object>) pass) {
                    passThrough.add(String.valueOf(o));
                }
            }
            Object frames = map.get("callerFrames");
            settings.apply(rows instanceof Number ? ((Number) rows).intValue() : AgentSettings.DEFAULT_ROWS_PER_RESULT, tableSet,
                    Boolean.TRUE.equals(map.get("outsideCallCapture")), Boolean.TRUE.equals(map.get("captureEnabled")),
                    ignore == null ? Collections.singletonList("SELECT 1") : ignoreStrings, passThrough,
                    frames instanceof Number ? ((Number) frames).intValue() : AgentSettings.DEFAULT_CALLER_FRAMES,
                    Boolean.TRUE.equals(map.get("indexInfo")));
            settings.applyLogs(Boolean.TRUE.equals(map.get("logsOn")));
        } catch (RuntimeException e) {
            AgentLog.warn("could not read ALFRED's settings answer");
        }
    }

    private static String appServer() {
        String jboss = System.getProperty("jboss.home.dir");
        return jboss != null ? "WildFly/JBoss" : null;
    }

    /** POSTs and returns the response body, or null on any failure. Never logs the body or the secret. */
    private String post(String path, String body) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(baseUrl + path).openConnection(java.net.Proxy.NO_PROXY);
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(2000);
            connection.setReadTimeout(5000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("X-Webhook-Secret", secret);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(bytes);
            }
            int status = connection.getResponseCode();
            if (status == 401) {
                AgentLog.warn("ALFRED rejected the agent's secret (401) - check secretFile/secret");
                return null;
            }
            if (status / 100 != 2) {
                AgentLog.warn("ALFRED answered " + status + " to " + path);
                return null;
            }
            try (InputStream in = connection.getInputStream()) {
                return read(in);
            }
        } catch (IOException e) {
            AgentLog.warn("cannot reach ALFRED at " + baseUrl + " (" + e.getClass().getSimpleName() + ")");
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int n;
        while ((n = in.read(buffer)) > 0) {
            out.write(buffer, 0, n);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
