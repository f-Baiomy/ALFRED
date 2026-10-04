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
    private final List<String> bodies = Collections.synchronizedList(new ArrayList<>());
    private final List<String> secrets = Collections.synchronizedList(new ArrayList<>());

    private String start(String heartbeatAnswer) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            secrets.add(exchange.getRequestHeaders().getFirst("X-Webhook-Secret"));
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
}
