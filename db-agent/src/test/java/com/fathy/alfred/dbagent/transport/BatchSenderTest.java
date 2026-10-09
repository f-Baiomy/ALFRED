package com.fathy.alfred.dbagent.transport;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class BatchSenderTest {

    private HttpServer server;
    private HttpServer second;
    private final List<String> bodies = Collections.synchronizedList(new ArrayList<>());
    private final List<String> secrets = Collections.synchronizedList(new ArrayList<>());
    private final List<String> keys = Collections.synchronizedList(new ArrayList<>());
    private final List<String> secondBodies = Collections.synchronizedList(new ArrayList<>());

    private String start(String heartbeatAnswer) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            secrets.add(exchange.getRequestHeaders().getFirst("X-Webhook-Secret"));
            keys.add(exchange.getRequestHeaders().getFirst("X-Alfred-Agent-Key"));
            bodies.add(exchange.getRequestURI().getPath() + " " + read(exchange.getRequestBody()));
            byte[] answer = (exchange.getRequestURI().getPath().endsWith("heartbeat") ? heartbeatAnswer : "{\"accepted\":1}").getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(202, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
        if (second != null) {
            second.stop(0);
        }
    }

    private String startSecond() throws Exception {
        second = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        second.createContext("/", exchange -> {
            secondBodies.add(exchange.getRequestURI().getPath() + " key=" + exchange.getRequestHeaders().getFirst("X-Alfred-Agent-Key"));
            byte[] answer = "{}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        second.start();
        return "http://127.0.0.1:" + second.getAddress().getPort();
    }

    @Test
    void followsTheAlfredTheReverseProxyNamesAndPresentsItsKey() throws Exception {
        String url = start("{}");
        String other = startSecond();
        BatchSender sender = new BatchSender("http://127.0.0.1:1", "stale-secret", "wallet-app", "agent-1", "1.0.0", new AgentSettings(), () -> { });
        // loaded with arguments nothing listens on: the first stamped request says where ALFRED really is
        sender.follow(other, "1759860000.abc");
        assertThat(sender.baseUrl()).isEqualTo(other);
        sender.heartbeat();
        assertThat(secondBodies).singleElement().isEqualTo("/db-capture/agent/heartbeat key=1759860000.abc");
        // the same address again is a no-op; a different one is followed again, the key kept
        sender.follow(other, null);
        sender.follow(url, null);
        sender.heartbeat();
        assertThat(keys).containsExactly("1759860000.abc");
        assertThat(secrets).containsExactly("stale-secret");
        // a later attach with the right secret replaces it
        sender.retarget(null, "s3cret");
        sender.heartbeat();
        assertThat(secrets).containsExactly("stale-secret", "s3cret");
    }

    @Test
    void threeMissedHeartbeatsMeanAlfredIsGoneAndTheFirstAnswerMeansItIsBack() throws Exception {
        java.util.concurrent.atomic.AtomicInteger status = new java.util.concurrent.atomic.AtomicInteger(200);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            byte[] answer = "{}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status.get(), answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        server.start();
        String url = "http://127.0.0.1:" + server.getAddress().getPort();
        List<String> events = Collections.synchronizedList(new ArrayList<>());
        BatchSender sender = new BatchSender(url, "s", "p", "a", "1", new AgentSettings(), () -> { });
        sender.presence(why -> events.add("gone: " + why), () -> events.add("back"));
        sender.heartbeat();
        assertThat(events).isEmpty();

        // the gateway is up, the backend behind it is not: 502 is "not there", like a refused connection
        status.set(502);
        sender.heartbeat();
        sender.heartbeat();
        assertThat(events).isEmpty();
        sender.marker(new MarkerRecord("c1", 1, "START", "t", "GET", "/x"));
        sender.heartbeat();
        assertThat(events).singleElement().asString().startsWith("gone: Alfred unreachable at " + url);
        assertThat(sender.queued()).isZero();
        sender.heartbeat();
        assertThat(events).hasSize(1);

        // a refusal (401) or a server error is an Alfred that is there
        status.set(401);
        sender.heartbeat();
        assertThat(events).containsExactly(events.get(0), "back");
    }

    @Test
    void nothingListeningIsGoneAndAnAttachStartsTheCountOver() {
        List<String> events = Collections.synchronizedList(new ArrayList<>());
        BatchSender sender = new BatchSender("http://127.0.0.1:1", "s", "p", "a", "1", new AgentSettings(), () -> { });
        sender.presence(why -> events.add("gone"), () -> events.add("back"));
        sender.heartbeat();
        sender.heartbeat();
        sender.retarget("http://127.0.0.1:1", null);
        sender.heartbeat();
        sender.heartbeat();
        assertThat(events).isEmpty();
        sender.heartbeat();
        assertThat(events).containsExactly("gone");
        assertThat(sender.gone()).isTrue();
    }

    @Test
    void postsBatchesWithTheSecretAndAppliesHeartbeatSettings() throws Exception {
        String url = start("{\"rowsPerResult\":7,\"beforeImageTables\":[\"Payment_Holds\"],\"outsideCallCapture\":true,\"captureEnabled\":true,\"ignorePatterns\":[\"QRTZ_%\"]}");
        AgentSettings settings = new AgentSettings();
        BatchSender sender = new BatchSender(url, "s3cret", "wallet-app", "agent-1", "1.0.0", settings, () -> { });
        sender.heartbeat();
        assertThat(settings.rowsPerResult()).isEqualTo(7);
        assertThat(settings.beforeImageFor("payment_holds")).isTrue();
        assertThat(settings.captureOutsideCalls()).isTrue();
        assertThat(settings.ignored("SELECT * FROM QRTZ_TRIGGERS")).isTrue();
        assertThat(settings.ignored("SELECT * FROM wallet")).isFalse();

        StatementRecord s = new StatementRecord();
        s.sid = "agent-1:1";
        s.thread = "t";
        s.kind = "SELECT";
        s.sql = "SELECT 2";
        s.outcome = new Outcome("ROWS");
        sender.statement(s);
        List<Object> drained = new ArrayList<>();
        drained.add(s);
        sender.send(drained);
        assertThat(secrets).containsOnly("s3cret");
        assertThat(bodies).anyMatch(b -> b.startsWith("/db-capture/agent/batch") && b.contains("\"sql\":\"SELECT 2\""));
    }

    @Test
    void theHeartbeatSaysWhichFeaturesTheJvmRuns() throws Exception {
        String url = start("{}");
        String before = com.fathy.alfred.dbagent.capture.AgentFeatures.published;
        try {
            com.fathy.alfred.dbagent.capture.AgentFeatures.published = "proxy";
            BatchSender sender = new BatchSender(url, "s", "p", "a", "1", new AgentSettings(), () -> { });
            sender.heartbeat();
            String hb = bodies.stream().filter(b -> b.startsWith("/db-capture/agent/heartbeat")).findFirst().orElse("");
            assertThat(hb).contains("\"features\":\"proxy\"");
        } finally {
            com.fathy.alfred.dbagent.capture.AgentFeatures.published = before;
        }
    }

    @Test
    void whatIsStillQueuedWhenTheJvmExitsIsPostedFirst() throws Exception {
        String url = start("{}");
        BatchSender sender = new BatchSender(url, "s", "p", "a", "1", new AgentSettings(), () -> { });
        StatementRecord s = new StatementRecord();
        s.sid = "a:1";
        s.thread = "t";
        s.kind = "SELECT";
        s.sql = "SELECT 7";
        s.outcome = new Outcome("ROWS");
        sender.statement(s); // never started: nothing drains the queue but the exit flush
        sender.flushOnExit();
        assertThat(sender.queued()).isZero();
        assertThat(bodies).anyMatch(b -> b.startsWith("/db-capture/agent/batch") && b.contains("\"sql\":\"SELECT 7\""));
    }

    @Test
    void aDeadBackendNeverBlocksTheApplicationThread() {
        BatchSender sender = new BatchSender("http://127.0.0.1:1", "s", "p", "a", "1", new AgentSettings(), () -> { });
        long start = System.nanoTime();
        for (int i = 0; i < 1000; i++) {
            StatementRecord s = new StatementRecord();
            s.sid = "a:" + i;
            s.sql = "SELECT 1";
            s.outcome = new Outcome("ROWS");
            sender.statement(s);
        }
        assertThat((System.nanoTime() - start) / 1_000_000).isLessThan(500);
        assertThat(sender.queued()).isEqualTo(1000);
    }

    @Test
    void aFullQueueDropsAndCounts() {
        BatchSender sender = new BatchSender("http://127.0.0.1:1", "s", "p", "a", "1", new AgentSettings(), () -> { });
        for (int i = 0; i < BatchSender.MAX_QUEUED + 25; i++) {
            StatementRecord s = new StatementRecord();
            s.sid = "a:" + i;
            s.callId = "call-1";
            s.sql = "SELECT 1";
            s.outcome = new Outcome("ROWS");
            sender.statement(s);
        }
        assertThat(sender.droppedTotal()).isEqualTo(25);
    }

    private static String read(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int n;
        while ((n = in.read(buffer)) > 0) {
            out.write(buffer, 0, n);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    @Test
    void aBigRedisCommandIsQueuedWholeOrDroppedWholeAndCounted() throws Exception {
        String url = start("{}");
        BatchSender sender = new BatchSender(url, "s", "p", "a", "1", new AgentSettings(), () -> { });
        RedisCommandRecord r = new RedisCommandRecord();
        r.sid = "a-r1";
        r.callId = "call-big";
        r.chunked = true;
        List<RedisChunkRecord> parts = new ArrayList<>();
        // more than the 64 MB queue can hold: nothing of it may be queued
        for (int i = 0; i < 300; i++) {
            parts.add(new RedisChunkRecord("a-r1", "args", i, 300, new byte[RedisChunkRecord.PART_BYTES]));
        }
        sender.redis(r, parts);
        assertThat(sender.queued()).isZero();
        assertThat(sender.droppedRedisOf("call-big")).isEqualTo(1);

        RedisCommandRecord small = new RedisCommandRecord();
        small.sid = "a-r2";
        small.callId = "call-ok";
        sender.redis(small, Collections.singletonList(new RedisChunkRecord("a-r2", "reply", 0, 1, new byte[10])));
        assertThat(sender.queued()).isEqualTo(2);
        List<Object> drained = new ArrayList<>();
        sender.drainInto(drained);
        sender.send(drained);
        String batch = bodies.stream().filter(b -> b.startsWith("/db-capture/agent/batch")).findFirst().orElse("");
        assertThat(batch).contains("\"redisChunks\"").contains("\"sid\":\"a-r2\"").contains("\"droppedRedis\":{\"call-big\":1}");
    }

    @Test
    void heartbeatAppliesTheRedisSettingsAndReportsWhatTheHooksSaw() throws Exception {
        String url = start("{\"redisBeforeImage\":true,\"redisHousekeeping\":true}");
        AgentSettings settings = new AgentSettings();
        BatchSender sender = new BatchSender(url, "s", "p", "a", "1", settings, () -> { });
        java.util.Map<String, Object> client = new java.util.LinkedHashMap<>();
        client.put("client", "lettuce");
        client.put("version", "6.8.2");
        client.put("connections", 1);
        client.put("servers", Collections.singletonList("redis:6379"));
        client.put("dbs", Collections.singletonList(0));
        java.util.Map<String, Object> seen = new java.util.LinkedHashMap<>();
        seen.put("clients", Collections.singletonList(client));
        seen.put("springCaches", Collections.singletonList("fareRules"));
        sender.redisSeen(() -> seen);
        sender.heartbeat();
        assertThat(settings.redisBeforeImage()).isTrue();
        assertThat(settings.redisHousekeeping()).isTrue();
        String hb = bodies.stream().filter(b -> b.startsWith("/db-capture/agent/heartbeat")).findFirst().orElse("");
        assertThat(hb).contains("\"redis\":{\"clients\":[{\"client\":\"lettuce\",\"version\":\"6.8.2\",\"connections\":1,\"servers\":[\"redis:6379\"],\"dbs\":[0]}],\"springCaches\":[\"fareRules\"]}");
    }
}
