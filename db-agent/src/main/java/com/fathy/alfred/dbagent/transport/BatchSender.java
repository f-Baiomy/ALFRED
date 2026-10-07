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
    /** Redis (specs/011-redis-capture): commands and big-value parts per batch, and the batch's byte budget for them -
     *  well under ALFRED's 32 MB request limit once base64 and JSON are added. */
    static final int MAX_REDIS_PER_BATCH = 2_000;
    static final int MAX_REDIS_CHUNKS_PER_BATCH = 64;
    static final long MAX_REDIS_BYTES_PER_BATCH = 20L * 1024 * 1024;
    static final long FLUSH_EVERY_MILLIS = 250;
    static final int FLUSH_AT = 500;
    static final long HEARTBEAT_EVERY_MILLIS = 10_000;
    private static final String OUTSIDE = "";

    /** Where ALFRED is and how to prove this is its agent - both can change after the start (see {@link #follow}). */
    private volatile String baseUrl;
    private volatile String secret;
    /** The key the reverse proxy stamped into the last call (X-Alfred-Agent-Key) - accepted by backend in place of the secret. */
    private volatile String agentKey;
    /** Warned about a 401 at most once a minute: a wrong secret must not fill the application's log four times a second. */
    private volatile long lastRejectedWarning;
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
    /** Redis commands not kept (queue full) per call - travel with the next batch. */
    private final ConcurrentHashMap<String, AtomicLong> droppedRedisByCall = new ConcurrentHashMap<>();
    /** What the Redis hooks saw (clients, Spring caches) - reported with each heartbeat. */
    private volatile java.util.function.Supplier<Map<String, Object>> redisSeen;
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

    /**
     * The reverse proxy said where ALFRED is (specs/006 proxy-headers: {@code alfred=}/{@code key=}). A different
     * address wins over the one the agent was loaded with - that one may name a port nothing listens on any more -
     * and is followed at once: the next tick heartbeats there, so the project shows "attached" within a second.
     */
    @Override
    public void follow(String url, String key) {
        if (key != null && !key.equals(agentKey)) {
            agentKey = key;
        }
        if (url != null && !url.equals(baseUrl)) {
            String was = baseUrl;
            baseUrl = url;
            lastHeartbeat = 0;
            AgentLog.info("ALFRED is at " + url + " (said by the reverse proxy that delivered the call) - reporting there instead of " + was);
        }
    }

    /** A new attach gave other arguments (URL, secret): use them from now on - the agent cannot be loaded twice. */
    public void retarget(String url, String newSecret) {
        boolean changed = false;
        if (url != null && !url.equals(baseUrl)) {
            AgentLog.info("reporting to " + url + " instead of " + baseUrl + " (attached again with other arguments)");
            baseUrl = url;
            changed = true;
        }
        if (newSecret != null && !newSecret.equals(secret)) {
            secret = newSecret;
            changed = true;
        }
        if (changed) {
            lastHeartbeat = 0;
        }
    }

    String baseUrl() {
        return baseUrl;
    }

    public void start() {
        thread = new Thread(this::loop, "alfred-agent-sender");
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

    /**
     * A command and its parts are queued together or not at all (research R4): a value is never shortened, and a
     * partial one would never become visible. Not kept - counted for its call.
     */
    @Override
    public void redis(RedisCommandRecord record, List<RedisChunkRecord> chunks) {
        long bytes = record.approxBytes();
        for (RedisChunkRecord c : chunks) {
            bytes += c.approxBytes();
        }
        synchronized (droppedRedisByCall) {
            if (queuedBytes.get() + bytes > MAX_QUEUED_BYTES || queue.remainingCapacity() < 1 + chunks.size()) {
                droppedRedis(record.callId);
                return;
            }
            List<Object> offered = new ArrayList<>(chunks.size() + 1);
            for (Object o : chunks) {
                if (!queue.offer(o)) {
                    undo(offered);
                    droppedRedis(record.callId);
                    return;
                }
                offered.add(o);
            }
            if (!queue.offer(record)) {
                undo(offered);
                droppedRedis(record.callId);
                return;
            }
            queuedBytes.addAndGet(bytes);
        }
    }

    private void undo(List<Object> offered) {
        for (Object o : offered) {
            queue.remove(o);
        }
    }

    private void droppedRedis(String callId) {
        droppedTotal.incrementAndGet();
        droppedRedisByCall.computeIfAbsent(callId == null ? OUTSIDE : callId, k -> new AtomicLong()).incrementAndGet();
    }

    long droppedRedisOf(String callId) {
        AtomicLong n = droppedRedisByCall.get(callId);
        return n == null ? 0 : n.get();
    }

    public void redisSeen(java.util.function.Supplier<Map<String, Object>> supplier) {
        this.redisSeen = supplier;
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

    void drainInto(List<Object> drained) {
        int[] counts = new int[5]; // statements, markers, logs, redis commands, redis parts
        long[] redisBytes = {0};
        for (Object o : drained) {
            count(o, counts, redisBytes);
        }
        while (counts[0] < MAX_STATEMENTS_PER_BATCH && counts[1] < MAX_MARKERS_PER_BATCH && counts[2] < MAX_LOGS_PER_BATCH
                && counts[3] < MAX_REDIS_PER_BATCH && counts[4] < MAX_REDIS_CHUNKS_PER_BATCH && redisBytes[0] < MAX_REDIS_BYTES_PER_BATCH) {
            Object next = queue.poll();
            if (next == null) {
                return;
            }
            drained.add(next);
            count(next, counts, redisBytes);
        }
    }

    private static void count(Object o, int[] counts, long[] redisBytes) {
        if (o instanceof StatementRecord) {
            counts[0]++;
        } else if (o instanceof LogRecord) {
            counts[2]++;
        } else if (o instanceof RedisCommandRecord) {
            counts[3]++;
            redisBytes[0] += ((RedisCommandRecord) o).approxBytes();
        } else if (o instanceof RedisChunkRecord) {
            counts[4]++;
            redisBytes[0] += ((RedisChunkRecord) o).approxBytes();
        } else {
            counts[1]++;
        }
    }

    /** Visible for the tests: one batch, posted now. */
    void send(List<Object> drained) {
        List<StatementRecord> statements = new ArrayList<>();
        List<MarkerRecord> markers = new ArrayList<>();
        List<LogRecord> logs = new ArrayList<>();
        List<RedisCommandRecord> redis = new ArrayList<>();
        List<RedisChunkRecord> chunks = new ArrayList<>();
        for (Object o : drained) {
            if (o instanceof StatementRecord) {
                StatementRecord s = (StatementRecord) o;
                queuedBytes.addAndGet(-s.approxBytes());
                statements.add(s);
            } else if (o instanceof LogRecord) {
                LogRecord l = (LogRecord) o;
                queuedBytes.addAndGet(-l.approxBytes());
                logs.add(l);
            } else if (o instanceof RedisCommandRecord) {
                RedisCommandRecord r = (RedisCommandRecord) o;
                queuedBytes.addAndGet(-r.approxBytes());
                redis.add(r);
            } else if (o instanceof RedisChunkRecord) {
                RedisChunkRecord c = (RedisChunkRecord) o;
                queuedBytes.addAndGet(-c.approxBytes());
                chunks.add(c);
            } else {
                markers.add((MarkerRecord) o);
            }
        }
        Map<String, Long> dropped = takeDropped();
        Map<String, Long> droppedLogs = take(droppedLogsByCall);
        Map<String, Long> droppedRedis = take(droppedRedisByCall);
        String body = BatchWriter.write(agentId, project, statements, markers, dropped, logs, droppedLogs, redis, chunks, droppedRedis);
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
                .name("droppedSinceStart").value(droppedTotal.get()).name("queuedStatements").value(queue.size());
        java.util.function.Supplier<Map<String, Object>> seen = redisSeen;
        if (seen != null) {
            BatchWriter.redisSeen(w, seen.get());
        }
        w.endObject();
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
            Object level = map.get("logLevel");
            settings.applyLogLevel(level == null ? null : String.valueOf(level));
            settings.applyRedis(Boolean.TRUE.equals(map.get("redisBeforeImage")), Boolean.TRUE.equals(map.get("redisHousekeeping")));
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
            String key = agentKey;
            if (key != null) {
                connection.setRequestProperty("X-Alfred-Agent-Key", key);
            }
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(bytes);
            }
            int status = connection.getResponseCode();
            if (status == 401) {
                long now = System.currentTimeMillis();
                if (now - lastRejectedWarning > 60_000) {
                    lastRejectedWarning = now;
                    AgentLog.warn("ALFRED at " + baseUrl + " rejected the agent (401): the secret is not its WEBHOOK_SECRET"
                            + (key == null ? " and no call carried a key yet - check secretFile/secret, or let a request through the reverse proxy"
                            : " and the key the reverse proxy stamped is not accepted - is that proxy this ALFRED's?"));
                }
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
