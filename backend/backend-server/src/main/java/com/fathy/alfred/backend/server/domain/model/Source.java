package com.fathy.alfred.backend.server.domain.model;

/** Where a setting's effective value came from. */
public enum Source {
    /** A line in .env. */
    ENV_FILE,
    /** No line in .env: the default from settings.properties. */
    DEFAULT,
    /** Docker install: the container's environment, shown read-only (FR-054). */
    PROCESS_ENV
}
