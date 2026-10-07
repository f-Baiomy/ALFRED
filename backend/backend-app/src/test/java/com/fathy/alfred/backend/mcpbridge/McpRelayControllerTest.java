package com.fathy.alfred.backend.mcpbridge;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** /mcp relayed to a fake MCP server: events in order, the session header both ways, 502 when it is down, 413 above 10 MB. */
class McpRelayControllerTest {

    private HttpServer upstream;
    private final AtomicReference<String> seenSession = new AtomicReference<>();
    private final AtomicReference<String> seenBody = new AtomicReference<>();

    @BeforeEach
    void start() throws IOException {
        upstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        upstream.createContext("/mcp", exchange -> {
            seenSession.set(exchange.getRequestHeaders().getFirst("Mcp-Session-Id"));
            seenBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            if (exchange.getRequestMethod().equals("DELETE")) {
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.getResponseHeaders().add("Mcp-Session-Id", "s-1");
            exchange.sendResponseHeaders(200, 0);
            try (OutputStream out = exchange.getResponseBody()) {
                for (int i = 1; i <= 3; i++) {
                    out.write(("event: message\ndata: {\"n\":" + i + "}\n\n").getBytes(StandardCharsets.UTF_8));
                    out.flush();
                    sleep();
                }
            }
        });
        upstream.start();
    }

    @AfterEach
    void stop() {
        upstream.stop(0);
    }

    private static void sleep() {
        try {
            Thread.sleep(50);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private MockMvc mvc(int port) {
        return MockMvcBuilders.standaloneSetup(new McpRelayController(port)).build();
    }

    @Test
    void eventsArriveInOrderWithTheSessionHeaderBothWays() throws Exception {
        String body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}";
        mvc(upstream.getAddress().getPort()).perform(post("/mcp").contentType(MediaType.APPLICATION_JSON)
                        .header("Accept", "application/json, text/event-stream").header("Mcp-Session-Id", "s-1").content(body))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Type", org.hamcrest.Matchers.startsWith("text/event-stream")))
                .andExpect(header().string("Mcp-Session-Id", "s-1"))
                .andExpect(header().string("X-Accel-Buffering", "no"))
                .andExpect(content().string("event: message\ndata: {\"n\":1}\n\nevent: message\ndata: {\"n\":2}\n\nevent: message\ndata: {\"n\":3}\n\n"));
        assertThat(seenSession.get()).isEqualTo("s-1");
        assertThat(seenBody.get()).isEqualTo(body);

        mvc(upstream.getAddress().getPort()).perform(delete("/mcp").header("Mcp-Session-Id", "s-1")).andExpect(status().isNoContent());
    }

    @Test
    void aStoppedMcpServerIs502AndAnOversizedBodyIs413() throws Exception {
        int free;
        try (ServerSocket socket = new ServerSocket(0)) {
            free = socket.getLocalPort();
        }
        mvc(free).perform(post("/mcp").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadGateway())
                .andExpect(content().string(org.hamcrest.Matchers.containsString("not running")));

        byte[] big = new byte[(int) McpRelayController.MAX_BODY_BYTES + 1];
        mvc(upstream.getAddress().getPort()).perform(post("/mcp").contentType(MediaType.APPLICATION_JSON).content(big))
                .andExpect(status().isPayloadTooLarge());
        assertThat(seenBody.get()).isNull();
    }
}
