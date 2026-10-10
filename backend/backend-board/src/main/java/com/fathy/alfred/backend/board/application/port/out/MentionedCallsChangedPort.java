package com.fathy.alfred.backend.board.application.port.out;

/**
 * Told when the set of live calls the board mentions changes, so the storage limits' kept-calls list (cached for
 * minutes) is refreshed at once and a newly mentioned call is not trimmed in the meantime (research R3).
 */
public interface MentionedCallsChangedPort {

    void mentionedCallsChanged();
}
