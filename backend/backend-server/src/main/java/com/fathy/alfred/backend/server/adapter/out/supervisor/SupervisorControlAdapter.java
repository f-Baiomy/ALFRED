package com.fathy.alfred.backend.server.adapter.out.supervisor;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.server.application.port.out.SupervisorPort;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import com.fathy.alfred.backend.server.domain.model.ServerStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * The supervisor's control API (contracts/supervisor-and-agent.md): 127.0.0.1 only, with the token from
 * data/run/control.json - readable by the service account alone, so nothing else on the machine can restart Alfred.
 * The file is read on every call: the supervisor writes a new port and token each time it starts.
 */
public class SupervisorControlAdapter implements SupervisorPort {

    private static final Logger log = LoggerFactory.getLogger(SupervisorControlAdapter.class);
    private static final Duration TIMEOUT = Duration.ofSeconds(30);

    private final Path controlFile;
    private final RuntimeMode mode;
    private final ObjectMapper mapper;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();

    public SupervisorControlAdapter(Path controlFile, RuntimeMode mode, ObjectMapper mapper) {
        this.controlFile = controlFile;
        this.mode = mode;
        this.mapper = mapper;
    }

    @Override
    public boolean available() {
        return mode == RuntimeMode.NATIVE && Files.isRegularFile(controlFile);
    }

    @Override
    public List<String> reload() {
        List<String> restarted = new ArrayList<>();
        call("POST", "/reload").ifPresent(body -> body.path("restarted").forEach(n -> restarted.add(n.asText())));
        return restarted;
    }

    @Override
    public void restartBackend() {
        call("POST", "/restart/backend");
    }

    @Override
    public void restartProxies() {
        call("POST", "/restart/proxies");
    }

    @Override
    public Optional<List<ServerStatus.ProcessStatus>> processes() {
        return call("GET", "/status").map(body -> {
            List<ServerStatus.ProcessStatus> out = new ArrayList<>();
            for (JsonNode p : body.path("processes")) {
                List<String> listeners = new ArrayList<>();
                p.path("listeners").forEach(l -> listeners.add(l.asText()));
                String started = p.path("startedAt").asText(null);
                out.add(new ServerStatus.ProcessStatus(p.path("name").asText(), state(p.path("state").asText()),
                        p.path("pid").asLong(), started == null || started.isEmpty() ? null : Instant.parse(started),
                        p.path("restarts").asInt(), listeners, p.path("detail").asText(""), -1));
            }
            return out;
        });
    }

    private static ServerStatus.ProcessState state(String text) {
        try {
            return ServerStatus.ProcessState.valueOf(text);
        } catch (IllegalArgumentException e) {
            return ServerStatus.ProcessState.UNKNOWN;
        }
    }

    private Optional<JsonNode> call(String method, String path) {
        if (!available()) {
            return Optional.empty();
        }
        try {
            JsonNode control = mapper.readTree(Files.readString(controlFile));
            HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + control.path("port").asInt() + path))
                    .timeout(TIMEOUT)
                    .header("X-Alfred-Control-Token", control.path("token").asText())
                    .method(method, HttpRequest.BodyPublishers.noBody())
                    .build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() >= 300) {
                log.warn("Supervisor {} {} answered {}", method, path, response.statusCode());
                return Optional.empty();
            }
            return Optional.of(response.body().isBlank() ? mapper.createObjectNode() : mapper.readTree(response.body()));
        } catch (IOException e) {
            log.warn("Supervisor {} {} failed: {}", method, path, e.getMessage());
            return Optional.empty();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Optional.empty();
        }
    }
}
