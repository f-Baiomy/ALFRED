package com.fathy.alfred.backend.server.domain.model;

/** How this backend was started: by the native install's supervisor, or by docker compose (start.py). */
public enum RuntimeMode {
    NATIVE, DOCKER;

    /** {@code ALFRED_RUNTIME}: "native" means the native install; anything else (including unset) is Docker. */
    public static RuntimeMode of(String value) {
        return "native".equalsIgnoreCase(value == null ? "" : value.trim()) ? NATIVE : DOCKER;
    }
}
