package com.fathy.alfred.backend.server.adapter.out.supervisor;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.server.application.port.out.SupervisorPort;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import com.fathy.alfred.backend.server.domain.model.ServerStatus;
import com.fathy.alfred.backend.server.domain.model.UpdateJob;
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

    @Override
    public Optional<List<ServerStatus.AgentAttach>> agents() {
        return call("GET", "/status").map(body -> {
            List<ServerStatus.AgentAttach> out = new ArrayList<>();
            for (JsonNode a : body.path("agents")) {
                String at = a.path("at").asText(null);
                ServerStatus.AgentAttachState state;
                try {
                    state = ServerStatus.AgentAttachState.valueOf(a.path("state").asText(""));
                } catch (IllegalArgumentException e) {
                    state = ServerStatus.AgentAttachState.UNKNOWN;
                }
                out.add(new ServerStatus.AgentAttach(a.path("project").asText(""), a.path("port").asInt(), a.path("pid").asLong(), state,
                        a.path("detail").asText(""), at == null || at.isEmpty() ? null : Instant.parse(at), a.path("features").asText(""),
                        a.path("jar").asText("")));
            }
            return out;
        });
    }

    @Override
    public boolean attachAgent(String project, List<String> features, boolean force) {
        var body = mapper.createObjectNode();
        body.put("project", project).put("force", force);
        var list = body.putArray("features");
        features.forEach(list::add);
        return call("POST", "/agents/attach", body).isPresent();
    }

    private static ServerStatus.ProcessState state(String text) {
        try {
            return ServerStatus.ProcessState.valueOf(text);
        } catch (IllegalArgumentException e) {
            return ServerStatus.ProcessState.UNKNOWN;
        }
    }

    @Override
    public boolean installUpdate(String version, String url, String sha256, long size) {
        var body = mapper.createObjectNode();
        body.put("version", version).put("url", url).put("sha256", sha256).put("size", size);
        return call("POST", "/update", body).isPresent();
    }

    @Override
    public Optional<UpdateJob> updateJob() {
        return call("GET", "/update").map(body -> new UpdateJob(
                jobState(body.path("state").asText("IDLE")), body.path("version").asText(""),
                body.path("downloadedBytes").asLong(0), body.path("totalBytes").asLong(0), body.path("error").asText("")));
    }

    private static UpdateJob.State jobState(String text) {
        try {
            return UpdateJob.State.valueOf(text);
        } catch (IllegalArgumentException e) {
            return UpdateJob.State.IDLE;
        }
    }

    private Optional<JsonNode> call(String method, String path) {
        return call(method, path, null);
    }

    /** Where the control API is and its token: data/run/control.json, which the supervisor rewrites at each start. */
    protected record Endpoint(String baseUrl, String token) {
    }

    protected Optional<Endpoint> endpoint() throws IOException {
        if (!available()) {
            return Optional.empty();
        }
        JsonNode control = mapper.readTree(Files.readString(controlFile));
        return Optional.of(new Endpoint("http://127.0.0.1:" + control.path("port").asInt(), control.path("token").asText()));
    }

    private Optional<JsonNode> call(String method, String path, JsonNode body) {
        try {
            Optional<Endpoint> endpoint = endpoint();
            if (endpoint.isEmpty()) {
                return Optional.empty();
            }
            HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint.get().baseUrl() + path))
                    .timeout(TIMEOUT)
                    .header("X-Alfred-Control-Token", endpoint.get().token())
                    .header("Content-Type", "application/json")
                    .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
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
