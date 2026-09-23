package com.fathy.alfred.backend.resend.adapter.out.http;

import com.fathy.alfred.backend.resend.domain.model.OutgoingCall;
import com.fathy.alfred.backend.resend.domain.model.SendOutcome;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

class JdkHttpCallSenderTest {

    private static JdkHttpCallSender senderWith(String reverseProxyHost, String internalCallServices) {
        return new JdkHttpCallSender("proxy", reverseProxyHost, "/nonexistent/mitmproxy-ca-cert.pem",
                5000, "odeysys:8081,core:8082", 8080, internalCallServices);
    }

    @Test
    void forwardPortForUsesTheMapThenTheDefault() {
        JdkHttpCallSender sender = senderWith("reverse-proxy", "");

        assertThat(sender.forwardPortFor("odeysys")).isEqualTo(8081);
        assertThat(sender.forwardPortFor(null)).isEqualTo(8080);
        assertThat(sender.forwardPortFor("gone")).isEqualTo(8080);
    }

    @Test
    void anInboundSendReachesTheHandlerWithTheRewrittenHostAndPathAndQuery() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicReference<String> capturedPath = new AtomicReference<>();
        AtomicReference<String> capturedQuery = new AtomicReference<>();
        AtomicReference<String> capturedHost = new AtomicReference<>();
        AtomicReference<String> capturedXA = new AtomicReference<>();
        AtomicReference<String> capturedBody = new AtomicReference<>();
        server.createContext("/api/x", exchange -> {
            capturedPath.set(exchange.getRequestURI().getPath());
            capturedQuery.set(exchange.getRequestURI().getQuery());
            capturedHost.set(exchange.getRequestHeaders().getFirst("Host"));
            capturedXA.set(exchange.getRequestHeaders().getFirst("X-A"));
            capturedBody.set(new String(exchange.getRequestBody().readAllBytes()));
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        server.start();
        try {
            int port = server.getAddress().getPort();
            JdkHttpCallSender sender = senderWith("127.0.0.1", "proj:" + port + ":9999");

            SendOutcome outcome = sender.send(new OutgoingCall("inbound", "POST",
                    "http://localhost:" + port + "/api/x?y=1",
                    Map.of("X-A", "1", "X-Request-Id", "n1"), "{}", "proj"));

            assertThat(capturedPath.get()).isEqualTo("/api/x");
            assertThat(capturedQuery.get()).isEqualTo("y=1");
            assertThat(capturedHost.get()).isEqualTo("localhost:" + port);
            assertThat(capturedXA.get()).isEqualTo("1");
            assertThat(capturedBody.get()).isEqualTo("{}");
            assertThat(outcome).isInstanceOf(SendOutcome.Sent.class);
            assertThat(((SendOutcome.Sent) outcome).status()).isEqualTo(204);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void inboundToAClosedPortIsReverseProxyNotRunning() throws Exception {
        ServerSocket socket = new ServerSocket(0);
        int port = socket.getLocalPort();
        socket.close();

        JdkHttpCallSender sender = senderWith("127.0.0.1", "proj:" + port + ":9999");
        SendOutcome outcome = sender.send(new OutgoingCall("inbound", "GET",
                "http://localhost:" + port + "/x", Map.of(), null, "proj"));

        assertThat(outcome).isInstanceOf(SendOutcome.ReverseProxyNotRunning.class);
    }

    @Test
    void anUnknownProjectIsFailedMentioningTheProject() {
        JdkHttpCallSender sender = senderWith("127.0.0.1", "");

        SendOutcome outcome = sender.send(new OutgoingCall("inbound", "GET",
                "http://localhost:1/x", Map.of(), null, "unknown-project"));

        assertThat(outcome).isInstanceOf(SendOutcome.Failed.class);
        assertThat(((SendOutcome.Failed) outcome).message()).contains("unknown-project");
    }

    @Test
    void aMissingCaFileDoesNotThrowWhenConstructingTheSender() {
        assertThatCode(() -> senderWith("reverse-proxy", "")).doesNotThrowAnyException();
    }
}
