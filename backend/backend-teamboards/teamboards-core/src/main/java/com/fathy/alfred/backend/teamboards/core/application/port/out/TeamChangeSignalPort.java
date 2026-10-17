package com.fathy.alfred.backend.teamboards.core.application.port.out;

/** "Something changed" on /ws/teamboards: {@code what} is items, changes, connections or start. Lists refetch; nothing polls. */
public interface TeamChangeSignalPort {

    void changed(String conn, String what);
}
