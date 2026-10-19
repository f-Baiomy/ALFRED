package com.fathy.alfred.backend.links.application.port.out;

import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Stream;

/**
 * The rest of this Alfred hears about linked Alfreds through this (backend-app/linksbridge): a remote cycle got calls
 * (so the host judges its requirements and re-tests, D25), a stream started or ended, an environment Alfred recorded a
 * test cycle for one of this Alfred's boards (D38). Every method has a do-nothing default.
 */
public interface RemoteListenerPort {

    default void signal(Link link, String channel, String json) {
    }

    default void streamChanged(Link link, Stream stream) {
    }

    /** An environment Alfred's test cycle for this Alfred's board: link it to the board as {@code cycleId@slug}. */
    default void envCycle(Link link, String boardId, String cycleId, String env, String name, java.util.List<Integer> retestFor) {
    }

    /** An environment Alfred's marks, ticks or re-tests for this Alfred's board changed. */
    default void envChanged(Link link, String boardId) {
    }
}
