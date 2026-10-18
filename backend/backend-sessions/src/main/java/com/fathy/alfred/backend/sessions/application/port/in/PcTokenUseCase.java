package com.fathy.alfred.backend.sessions.application.port.in;

import com.fathy.alfred.backend.sessions.domain.model.Caller;

import java.util.Optional;

/**
 * The Azure DevOps token entered in a browser, to be kept on one of the user's PCs (specs/031, docs/team.md): Alfred
 * passes it through to that PC's helper on its next heartbeat - in memory only, once, within ten minutes - and the helper
 * keeps it encrypted for the Windows user (DPAPI) and hands it back to Alfred's memory whenever it starts. Never on
 * Alfred's disk, in a log, or in an answer to a browser.
 */
public interface PcTokenUseCase {

    /** Queues the token (or, with {@code token} null, "forget it") for {@code helperKeyId}, which must be the caller's own PC. */
    boolean send(Caller caller, String helperKeyId, String token);

    /** What waits for this helper: the token, "" for forget, empty for nothing - and it no longer waits. */
    Optional<String> take(Caller helper);
}
