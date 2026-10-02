package com.fathy.alfred.backend.relive.adapter.out.proxy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.application.port.in.EvaluateChecksUseCase.ChecksUnavailableException;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ProxyCheckEvaluatorAdapterTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private HttpServer proxy;

    @AfterEach
    void stop() {
        if (proxy != null) proxy.stop(0);
    }

    /** A stand-in proxy: records what was asked of it, answers like the addon does. */
    private int fakeProxy(int status, String answer, AtomicReference<String> seen) throws Exception {
        proxy = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        proxy.createContext("/", exchange -> {
            seen.set(exchange.getRequestURI() + " " + new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] body = answer.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        proxy.start();
        return proxy.getAddress().getPort();
    }

    @Test
    void sendsTheChecksThroughTheProxyToTheReservedHost() throws Exception {
        AtomicReference<String> seen = new AtomicReference<>();
        int port = fakeProxy(200, "{\"groups\":[{\"passed\":true,\"rows\":[]}]}", seen);
        ProxyCheckEvaluatorAdapter adapter = new ProxyCheckEvaluatorAdapter("127.0.0.1", port, 3000);

        JsonNode result = adapter.evaluate(mapper.readTree("{\"groups\":[],\"answer\":{\"status\":200}}"));

        assertThat(result.path("groups").get(0).path("passed").asBoolean()).isTrue();
        assertThat(seen.get()).startsWith("http://alfred-checks.internal/evaluate {\"groups\":[]");
    }

    @Test
    void aProxyErrorOrNoProxyIsReportedAsUnavailable() throws Exception {
        int port = fakeProxy(400, "{\"error\":\"bad\"}", new AtomicReference<>());
        ProxyCheckEvaluatorAdapter adapter = new ProxyCheckEvaluatorAdapter("127.0.0.1", port, 3000);
        assertThatThrownBy(() -> adapter.evaluate(mapper.readTree("{}"))).isInstanceOf(ChecksUnavailableException.class).hasMessageContaining("bad");

        stop();
        assertThatThrownBy(() -> adapter.evaluate(mapper.readTree("{}"))).isInstanceOf(ChecksUnavailableException.class);
    }
}
