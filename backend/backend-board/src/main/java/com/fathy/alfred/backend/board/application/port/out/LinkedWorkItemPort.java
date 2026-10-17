package com.fathy.alfred.backend.board.application.port.out;

import java.util.List;
import java.util.Optional;

/**
 * The work item a board was opened from (specs/027 US8/US9), read from the Team cache by backend-app/teamboardsbridge.
 * Empty when the board has none or the Team feature is not wired (the default).
 */
public interface LinkedWorkItemPort {

    /** One field that changed in the tracker after the board was set up. */
    record FieldChange(String field, String from, String to, String by, String at) {
    }

    /**
     * The linked item: its connection and id, a snapshot for the chip (title, state, type, url...) as text pairs, the
     * provider's label ("Azure DevOps") and what changed since setup.
     */
    record LinkedItem(String connection, String itemId, String provider, java.util.Map<String, String> snapshot,
                      List<FieldChange> changedSinceSetup) {
    }

    default Optional<LinkedItem> linkedTo(String boardId) {
        return Optional.empty();
    }

    /** The user saved or dismissed the change: nothing up to now counts as changed. */
    default void seen(String boardId) {
    }

    /** The board is gone: its link goes, so the item offers Start again. */
    default void boardDeleted(String boardId) {
    }
}
