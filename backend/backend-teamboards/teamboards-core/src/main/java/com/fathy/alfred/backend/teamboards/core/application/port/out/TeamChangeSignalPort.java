package com.fathy.alfred.backend.teamboards.core.application.port.out;

/** "Something changed" on /ws/teamboards: {@code what} is items, changes, connections or start. Lists refetch; nothing polls. */
public interface TeamChangeSignalPort {

    void changed(String conn, String what);

    /** A refresh run in the background ended: its outcome for the browser that started it (and everyone's lists). */
    default void refreshed(String conn, com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.RefreshResult result) {
        changed(conn, "refresh");
    }
}
