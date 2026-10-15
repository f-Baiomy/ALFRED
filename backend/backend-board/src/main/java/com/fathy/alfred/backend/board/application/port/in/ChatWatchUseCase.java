package com.fathy.alfred.backend.board.application.port.in;

/**
 * The board chats' watches (specs/022 FR-030, FR-031), driven by events only: a live inbound call completed (from
 * backend-app/boardbridge, never slowing the caller), and the board's own "changed" signal for verdicts. "Tell me when"
 * watches post once and end; "watch while I test" queues one check per batch of calls for the chat's Claude.
 */
public interface ChatWatchUseCase {

    void callCompleted(String project, String callId, String endpoint, Integer status);
}
