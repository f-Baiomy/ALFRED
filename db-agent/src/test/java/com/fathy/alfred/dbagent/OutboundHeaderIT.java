package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.transport.MarkerRecord;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;

import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static org.assertj.core.api.Assertions.assertThat;

/** A supplier call made inside a captured call carries X-Alfred-Parent with the call's next sequence number. */
class OutboundHeaderIT {

    private HttpServer server;
    private final List<String> seen = Collections.synchronizedList(new ArrayList<>());

    @BeforeEach
    void start() throws Exception {
        AgentTestSupport.reset();
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            seen.add(String.valueOf(exchange.getRequestHeaders().getFirst("X-Alfred-Parent")));
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    @Test
    void insideACallTheHeaderAndMarkerShareTheSequence() throws Exception {
        AgentTestSupport.inCall("call-http", () -> {
            get("/v1/charge?amount=120");
            get("/v1/notify");
        }, true);
        get("/outside");

        assertThat(seen).containsExactly("call-http; seq=1", "call-http; seq=2", "null");
        List<MarkerRecord> markers = SINK.markers().stream().filter(m -> m.type.equals("HTTP_OUT")).collect(Collectors.toList());
        assertThat(markers).extracting(m -> m.seq).containsExactly(1, 2);
        assertThat(markers.get(0).url).endsWith("/v1/charge");
        assertThat(markers.get(0).method).isEqualTo("GET");
    }

    private void get(String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getAddress().getPort() + path).openConnection(java.net.Proxy.NO_PROXY);
        c.getResponseCode();
        try (InputStream ignored = c.getErrorStream()) {
            c.disconnect();
        }
    }
}
