package com.fathy.alfred.backend.server.domain.model;

/** How a saved change takes effect (research R8). */
public enum ApplyMode {
    /** The owning slice applies it at once through a runtime setter. */
    LIVE,
    /** The supervisor restarts the proxies with arguments rebuilt from .env. */
    PROXIES,
    /** Read once at process start: the change waits for a restart of Alfred. */
    RESTART
}
