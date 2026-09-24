package com.fathy.alfred.backend.resend.adapter.out.http;

import com.fathy.alfred.backend.resend.application.port.out.OutgoingCall;
import com.fathy.alfred.backend.resend.application.port.out.SendOutcome;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

class JdkHttpCallSenderTest {

    private HttpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
    }

    private HttpServer startServer(AtomicReference<com.sun.net.httpserver.HttpExchange> captured) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            captured.set(exchange);
            byte[] body = "ok".getBytes();
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        this.server = server;
        return server;
    }

    @Test
    void anInboundSendReachesTheHandlerWithTheRewrittenHostAndPathAndQuery() throws Exception {
        AtomicReference<com.sun.net.httpserver.HttpExchange> captured = new AtomicReference<>();
        HttpServer server = startServer(captured);
        int port = server.getAddress().getPort();

        JdkHttpCallSender sender = new JdkHttpCallSender(Duration.ofSeconds(5), "proxy.invalid", 8080,
                Map.of(), "127.0.0.1", Map.of("odeysys", port), null);

        OutgoingCall call = new OutgoingCall("inbound", "GET",
                "http://localhost:9001/api/fares?x=1", Map.of("X-Trace", "abc"), null, "localhost", "odeysys");
        SendOutcome outcome = sender.send(call);

        assertThat(outcome).isInstanceOf(SendOutcome.Sent.class);
        assertThat(((SendOutcome.Sent) outcome).status()).isEqualTo(200);
        assertThat(captured.get().getRequestURI().toString()).isEqualTo("/api/fares?x=1");
        assertThat(captured.get().getRequestHeaders().getFirst("Host")).isEqualTo("localhost:" + port);
        assertThat(captured.get().getRequestHeaders().getFirst("X-Trace")).isEqualTo("abc");
    }

    @Test
    void aConnectionRefusedOnInboundBecomesReverseProxyNotRunning() {
        int unusedPort = findClosedPort();
        JdkHttpCallSender sender = new JdkHttpCallSender(Duration.ofSeconds(2), "proxy.invalid", 8080,
                Map.of(), "127.0.0.1", Map.of("odeysys", unusedPort), null);

        OutgoingCall call = new OutgoingCall("inbound", "GET", "http://localhost:9001/x", Map.of(), null, "localhost", "odeysys");
        SendOutcome outcome = sender.send(call);

        assertThat(outcome).isInstanceOf(SendOutcome.ReverseProxyNotRunning.class);
    }

    @Test
    void restrictedHeadersAreNeverCopiedThrough() throws Exception {
        AtomicReference<com.sun.net.httpserver.HttpExchange> captured = new AtomicReference<>();
        HttpServer server = startServer(captured);
        int port = server.getAddress().getPort();

        JdkHttpCallSender sender = new JdkHttpCallSender(Duration.ofSeconds(5), "proxy.invalid", 8080,
                Map.of(), "127.0.0.1", Map.of("odeysys", port), null);

        OutgoingCall call = new OutgoingCall("inbound", "POST", "http://localhost:9001/x",
                Map.of("Content-Length", "999", "Connection", "keep-alive", "X-Ok", "1"), "body", "localhost", "odeysys");
        sender.send(call);

        assertThat(captured.get().getRequestHeaders().getFirst("X-Ok")).isEqualTo("1");
        // The JDK's own HttpClient sets Content-Length correctly for the actual body ("body" = 4 bytes),
        // proving the caller-supplied (wrong) value of 999 was never forwarded.
        assertThat(captured.get().getRequestHeaders().getFirst("Content-Length")).isEqualTo("4");
    }

    @Test
    void aServiceWithNoMappedPortFallsBackToTheDefault() {
        JdkHttpCallSender sender = new JdkHttpCallSender(Duration.ofSeconds(2), "proxy.invalid", 8080,
                Map.of("odeysys", 8091), "127.0.0.1", Map.of(), null);

        assertThat(sender.forwardProxyPortFor("odeysys")).isEqualTo(8091);
        assertThat(sender.forwardProxyPortFor("unmapped")).isEqualTo(8080);
    }

    private static int findClosedPort() {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }
}
