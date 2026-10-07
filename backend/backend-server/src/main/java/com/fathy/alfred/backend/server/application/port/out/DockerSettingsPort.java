package com.fathy.alfred.backend.server.application.port.out;

import java.util.Optional;

/**
 * Docker mode (FR-054): a setting's effective value as the backend container received it - its own environment,
 * through the "docker" names of settings-env-map.json. Empty when Docker does not use the setting.
 */
public interface DockerSettingsPort {

    Optional<String> effectiveValue(String key);
}
