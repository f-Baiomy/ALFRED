package com.fathy.alfred.backend.server.adapter.out.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.server.application.port.out.DockerSettingsPort;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;

/**
 * Docker mode's effective values (FR-054): the backend container's environment, through the "docker" variable names
 * of settings-env-map.json (e.g. ALFRED_LOGS_WATCH_DIRS reaches the container as LOGS_WATCH_DIRS).
 */
public class ProcessEnvDockerSettingsAdapter implements DockerSettingsPort {

    private final JsonNode map;
    private final Function<String, String> environment;

    public ProcessEnvDockerSettingsAdapter(ObjectMapper mapper) {
        this(mapper, System::getenv);
    }

    ProcessEnvDockerSettingsAdapter(ObjectMapper mapper, Function<String, String> environment) {
        try (InputStream in = ProcessEnvDockerSettingsAdapter.class.getResourceAsStream("/settings-env-map.json")) {
            this.map = mapper.readTree(in).path("settings");
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        this.environment = environment;
    }

    @Override
    public Optional<String> effectiveValue(String key) {
        JsonNode docker = map.path(key).path("docker");
        if (docker.isMissingNode() || docker.isNull()) {
            return Optional.empty();
        }
        return Optional.ofNullable(environment.apply(docker.asText()));
    }

    /** For tests: a fixed environment. */
    public static ProcessEnvDockerSettingsAdapter withEnvironment(ObjectMapper mapper, Map<String, String> env) {
        return new ProcessEnvDockerSettingsAdapter(mapper, env::get);
    }
}
