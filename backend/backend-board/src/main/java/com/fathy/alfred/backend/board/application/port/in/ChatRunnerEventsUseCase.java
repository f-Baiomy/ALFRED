package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.LiveWork;

/**
 * What the runners' heartbeats and reports tell the chats (specs/022): a runner that started holding a chat puts back
 * the messages an earlier runner took and never answered; a run on a chat message that ended without an answer stops it.
 */
public interface ChatRunnerEventsUseCase {

    /** A runner started answering a chat: {@code cycleId} null for the project's live runner. */
    void runnerStarted(String project, String cycleId, String chatId);

    /** A run reported for a chat message ended ({@code state} DONE, FAILED or STOPPED). */
    void runEnded(long messageId, LiveWork.State state, String outcome);
}
