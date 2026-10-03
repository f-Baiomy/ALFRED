package com.fathy.alfred.backend.relive.domain.model;

import java.util.List;

/** Cycle-wide defaults (FR-034 and friends). {@code internalHosts} lists hosts (or suffixes,
 *  e.g. ".internal") that never count as "reaching an external system" (research D14/D15).
 *  {@code carryCookies} (Automatic runs: each Set-Cookie a step receives replaces that cookie in
 *  later steps) and {@code replayIgnoresCredentials} (a REPLAY call's match leaves out the
 *  Authorization header) are null in a cycle saved before they existed, which reads as on. */
public record ReliveSettings(
        String inboundMode,
        String onFailure,
        String onDifferences,
        String defaultDriver,
        List<String> internalHosts,
        Boolean carryCookies,
        Boolean replayIgnoresCredentials
) {
    public ReliveSettings(String inboundMode, String onFailure, String onDifferences, String defaultDriver,
                          List<String> internalHosts) {
        this(inboundMode, onFailure, onDifferences, defaultDriver, internalHosts, null, null);
    }

    public boolean replayIgnoresCredentialsOrDefault() {
        return replayIgnoresCredentials == null || replayIgnoresCredentials;
    }
}
