package com.fathy.alfred.backend.server.application.port.out;

import java.util.Map;

/**
 * Applies a saved setting in the slice that owns it, without a restart (research R8). Implemented by
 * backend-app/serverbridge, which calls the owning slices' runtime setters - this slice never depends on them directly.
 */
public interface LiveSettingsPort {

    /**
     * @param effective every setting's value after the save (some changes need two values, e.g. the project list and
     *                  whether inbound logging is on)
     * @throws IllegalArgumentException when this backend has nothing to apply for the key
     */
    void apply(String key, Map<String, String> effective);
}
