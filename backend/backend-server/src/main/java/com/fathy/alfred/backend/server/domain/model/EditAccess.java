package com.fathy.alfred.backend.server.domain.model;

/**
 * Whether the current request may change server settings or restart Alfred (FR-050..054), and why.
 *
 * @param howToEdit shown to a read-only viewer: how to reach Alfred with edit rights (FR-053)
 */
public record EditAccess(boolean allowed, Reason reason, String clientAddress, String howToEdit) {

    public enum Reason {
        /** This machine. */
        LOCAL,
        /** A private network address, allowed by "lan". */
        LAN,
        /** An address or range listed explicitly. */
        LISTED,
        /** The request came through the Cloudflare tunnel: always read-only. */
        TUNNEL,
        /** Not in ALFRED_SETTINGS_EDIT_FROM. */
        NOT_LISTED,
        /** Alfred runs the Docker way: settings are changed in .env and applied with restart.py. */
        DOCKER_MODE
    }
}
