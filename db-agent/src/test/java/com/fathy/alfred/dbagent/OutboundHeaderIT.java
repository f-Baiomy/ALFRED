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

    @Test
    void aPostWithABodyIsOneSupplierCallNotOnePerConnectionMethod() throws Exception {
        AgentTestSupport.inCall("call-post", () -> {
            for (int i = 0; i < 2; i++) {
                HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getAddress().getPort() + "/api/FlightSearch/Search")
                        .openConnection(java.net.Proxy.NO_PROXY);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.connect();
                try (java.io.OutputStream out = c.getOutputStream()) {
                    out.write("{}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
                }
                // How response handling code really reads it: status, headers, body - each goes through
                // getInputStream on an already-connected connection.
                c.getResponseCode();
                c.getHeaderField("Content-Type");
                c.getResponseMessage();
                c.getResponseCode();
                try (InputStream ignored = c.getErrorStream()) {
                    c.disconnect();
                }
            }
        }, true);

        assertThat(seen).containsExactly("call-post; seq=1", "call-post; seq=2");
        List<MarkerRecord> markers = SINK.markers().stream().filter(m -> m.type.equals("HTTP_OUT")).collect(Collectors.toList());
        assertThat(markers).extracting(m -> m.seq).containsExactly(1, 2);
        assertThat(markers.get(0).method).isEqualTo("POST");
    }

    /**
     * Over HTTPS the JDK connection does not report X-Alfred-Parent back once connected, so the hook - which runs on
     * connect, getOutputStream and on every getInputStream behind each status/header read - used to record a new
     * supplier call each time: 2 real POSTs showed as 40 (odeysys, flight-search). One connection is one call.
     */
    @Test
    void repeatedHooksOnOneConnectionRecordOneSupplierCall() throws Exception {
        Object connection = new Object();
        Object other = new Object();
        String[] headers = new String[4];
        AgentTestSupport.inCall("call-https", () -> {
            for (int i = 0; i < 3; i++) {
                headers[i] = AgentTestSupport.DISPATCHER.outboundHeaderFor(connection, "POST", "https://ndc.example/api/FlightSearch/Search");
            }
            headers[3] = AgentTestSupport.DISPATCHER.outboundHeaderFor(other, "POST", "https://ndc.example/api/FlightSearch/Search");
        }, true);

        assertThat(headers).containsExactly("call-https; seq=1", "call-https; seq=1", "call-https; seq=1", "call-https; seq=2");
        assertThat(SINK.markers().stream().filter(m -> m.type.equals("HTTP_OUT")).count()).isEqualTo(2);
    }

    private void get(String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getAddress().getPort() + path).openConnection(java.net.Proxy.NO_PROXY);
        c.getResponseCode();
        try (InputStream ignored = c.getErrorStream()) {
            c.disconnect();
        }
    }
}
