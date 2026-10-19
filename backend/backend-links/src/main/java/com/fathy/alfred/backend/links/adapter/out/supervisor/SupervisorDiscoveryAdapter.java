package com.fathy.alfred.backend.links.adapter.out.supervisor;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.links.application.port.out.DiscoveryPort;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.links.domain.model.Self;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

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
import java.util.Map;
import java.util.Optional;

/**
 * LAN discovery through the native supervisor's control API (GET /discovery, POST /discovery/announce), with the token
 * from data/run/control.json - read on every call, as the supervisor writes a new one at each start. In Docker there is
 * no supervisor and nothing to hear: {@link #heard()} says so.
 */
@Component
public class SupervisorDiscoveryAdapter implements DiscoveryPort {

    private static final Logger log = LoggerFactory.getLogger(SupervisorDiscoveryAdapter.class);
    static final String DOCKER = "Docker cannot see the LAN - type the other Alfred's address instead";
    static final String NO_SUPERVISOR = "LAN discovery runs with the installed Alfred (alfred run) - type the address instead";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final boolean nativeRuntime;
    private final Path controlFile;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();

    public SupervisorDiscoveryAdapter(@Value("${ALFRED_RUNTIME:docker}") String runtime,
                                      @Value("${ALFRED_CONTROL_FILE:data/run/control.json}") String controlFile) {
        this.nativeRuntime = "native".equalsIgnoreCase(runtime);
        this.controlFile = Path.of(controlFile);
    }

    @Override
    public void announce(Self self) {
        if (!nativeRuntime) {
            return;
        }
        try {
            call("POST", "/discovery/announce", MAPPER.writeValueAsString(
                    Map.of("id", self.alfredId(), "name", self.name(), "version", self.version(), "announce", self.announce())));
        } catch (JsonProcessingException e) {
            log.debug("Announce not written: {}", e.getMessage());
        }
    }

    @Override
    public Heard heard() {
        if (!nativeRuntime) {
            return new Heard(false, DOCKER, List.of());
        }
        Optional<JsonNode> body = call("GET", "/discovery", null);
        if (body.isEmpty()) {
            return new Heard(false, NO_SUPERVISOR, List.of());
        }
        JsonNode b = body.get();
        List<Found> found = new ArrayList<>();
        for (JsonNode f : b.path("found")) {
            String seen = f.path("seenAt").asText("");
            Instant at;
            try {
                at = seen.isEmpty() ? null : Instant.parse(seen);
            } catch (RuntimeException e) {
                at = null;
            }
            found.add(new Found(f.path("alfredId").asText(""), f.path("name").asText(""), f.path("address").asText(""),
                    f.path("version").asText(""), at));
        }
        String why = b.path("why").isTextual() ? b.path("why").asText() : null;
        return new Heard(b.path("available").asBoolean(false), why, found);
    }

    private Optional<JsonNode> call(String method, String path, String body) {
        try {
            if (!Files.isRegularFile(controlFile)) {
                return Optional.empty();
            }
            JsonNode control = MAPPER.readTree(Files.readString(controlFile));
            HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + control.path("port").asInt() + path))
                    .timeout(Duration.ofSeconds(5))
                    .header("X-Alfred-Control-Token", control.path("token").asText())
                    .header("Content-Type", "application/json")
                    .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() >= 300) {
                log.debug("Supervisor {} {} answered {}", method, path, response.statusCode());
                return Optional.empty();
            }
            return Optional.of(MAPPER.readTree(response.body().isBlank() ? "{}" : response.body()));
        } catch (IOException e) {
            log.debug("Supervisor {} {} failed: {}", method, path, e.getMessage());
            return Optional.empty();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Optional.empty();
        }
    }
}
