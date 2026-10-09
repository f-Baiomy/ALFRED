package com.fathy.alfred.backend.server.adapter.out.supervisor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.server.domain.model.ServerStatus;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** Docker's backend asks the agent host on the machine (alfred_agent_host.py) the way it asks the native supervisor. */
class AgentHostAdapterTest {

    private HttpServer host;
    private final List<String> seen = Collections.synchronizedList(new ArrayList<>());

    @AfterEach
    void stop() {
        if (host != null) {
            host.stop(0);
        }
    }

    private String start() throws Exception {
        host = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        host.createContext("/", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            seen.add(exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath() + " "
                    + exchange.getRequestHeaders().getFirst("X-Alfred-Control-Token") + " " + body);
            byte[] answer = (exchange.getRequestURI().getPath().equals("/status")
                    ? "{\"processes\":[],\"agents\":[{\"project\":\"odeysys\",\"port\":9001,\"pid\":4348,\"state\":\"ELSEWHERE\","
                      + "\"detail\":\"the agent reports to the Alfred at http://127.0.0.1:3001\",\"at\":null,\"features\":\"proxy,db\"}]}"
                    : "{\"accepted\":true}").getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(exchange.getRequestURI().getPath().equals("/status") ? 200 : 202, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        host.start();
        return "http://127.0.0.1:" + host.getAddress().getPort() + "/";
    }

    @Test
    void attachesAndReportsThroughTheAgentHostButIsNoSupervisor() throws Exception {
        AgentHostAdapter adapter = new AgentHostAdapter(start(), "t0k", new ObjectMapper());
        assertThat(adapter.available()).as("no restarts, reloads or updates in Docker").isFalse();
        assertThat(adapter.attaches()).isTrue();

        assertThat(adapter.attachAgent("odeysys", List.of("proxy", "db"), true)).isTrue();
        assertThat(adapter.agents()).get().asList().singleElement().satisfies(a -> {
            ServerStatus.AgentAttach agent = (ServerStatus.AgentAttach) a;
            assertThat(agent.state()).isEqualTo(ServerStatus.AgentAttachState.ELSEWHERE);
            assertThat(agent.pid()).isEqualTo(4348);
        });
        assertThat(seen).first().asString()
                .isEqualTo("POST /agents/attach t0k {\"project\":\"odeysys\",\"force\":true,\"features\":[\"proxy\",\"db\"]}");
        assertThat(seen).last().asString().startsWith("GET /status t0k");
    }

    @Test
    void withoutAUrlOrTokenNothingIsAsked() {
        assertThat(new AgentHostAdapter("http://host.docker.internal:3098", "", new ObjectMapper()).attaches()).isFalse();
        assertThat(new AgentHostAdapter("", "t", new ObjectMapper()).attachAgent("odeysys", List.of("db"), false)).isFalse();
    }
}
