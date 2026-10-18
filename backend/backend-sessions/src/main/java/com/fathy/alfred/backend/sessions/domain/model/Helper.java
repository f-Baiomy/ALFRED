package com.fathy.alfred.backend.sessions.domain.model;

import java.time.Instant;

/**
 * A user's helper on one PC (specs/031): it connects out to Alfred, claims the commands meant for its PC and runs Claude
 * there. {@code info} is what its last heartbeat said about the PC (Claude account, Desktop found, version, projects and
 * folders) as JSON - shown to its own user only. The key itself is never kept, only its hash.
 */
public record Helper(String keyId, String user, String machine, String claudeAccount, String ip, String info, Instant createdAt,
                     Instant lastSeen, Instant revokedAt) {

    /** Online: beat within the last two minutes. */
    public boolean online(Instant now) {
        return revokedAt == null && lastSeen != null && lastSeen.plusSeconds(120).isAfter(now);
    }
}
