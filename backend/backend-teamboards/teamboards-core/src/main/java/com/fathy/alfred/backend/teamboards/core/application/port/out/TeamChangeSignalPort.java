package com.fathy.alfred.backend.teamboards.core.application.port.out;

import java.util.Map;

/**
 * "Something changed" on /ws/teamboards (specs/028 contracts): {@code what} is token, lists, connections, mappings, sync,
 * incoming, write, hook, items or start. Pages fetch on it; nothing polls. Never a token, never an item's content.
 */
public interface TeamChangeSignalPort {

    void changed(String conn, String what);

    /** A board's Azure side changed ({@code what}: items, sync, incoming, write, cards), with a few plain extras. */
    default void board(String boardId, String conn, String what, Map<String, Object> extra) {
        changed(conn, what);
    }
}
