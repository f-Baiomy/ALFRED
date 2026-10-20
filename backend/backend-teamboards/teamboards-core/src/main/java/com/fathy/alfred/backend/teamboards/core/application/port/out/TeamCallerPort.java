package com.fathy.alfred.backend.teamboards.core.application.port.out;

import java.util.Optional;

/**
 * Who is asking, when a user's paired browser or helper sent the request (specs/031): their tracker token is their own -
 * entered by them, used for their searches and writes only, never read by another user. Empty outside a request (background
 * work) or for an unpaired caller. Implemented by backend-app/teamboardsbridge from the request's X-Alfred-Key.
 */
public interface TeamCallerPort {

    Optional<String> user();

    /**
     * Why the current request may not approve, reject or retry a bundle (specs/038 G-4), or empty when it may: only the
     * user's own browser decides - never a helper's key (the MCP server and the runners carry it), never a request through
     * a Claude session ({@code X-Alfred-Via}), never a script with no browser behind it.
     */
    default Optional<String> refuseDecision() {
        return Optional.empty();
    }
}
