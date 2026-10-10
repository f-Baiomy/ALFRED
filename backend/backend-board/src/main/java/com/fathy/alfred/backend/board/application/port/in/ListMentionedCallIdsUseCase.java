package com.fathy.alfred.backend.board.application.port.in;

import java.util.Set;

/** Live calls any card mentions - kept out of the storage limits by backend-app's kept-calls list (research R3). */
public interface ListMentionedCallIdsUseCase {

    Set<String> mentionedLiveCallIds();
}
