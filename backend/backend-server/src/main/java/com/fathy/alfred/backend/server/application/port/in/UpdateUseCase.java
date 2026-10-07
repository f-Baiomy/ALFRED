package com.fathy.alfred.backend.server.application.port.in;

import com.fathy.alfred.backend.server.domain.model.UpdateStatus;

/** Check for updates and install one (the Server card's update row, {@code alfred update}). */
public interface UpdateUseCase {

    /** The last check's result, without reading the feed. */
    UpdateStatus status();

    /** Reads the feed now. Never throws: a failed check is reported in {@link UpdateStatus#error()}. */
    UpdateStatus check();

    /**
     * Asks the supervisor to download, verify and run the installer of the available update.
     *
     * @throws IllegalStateException in Docker mode, with no update available, or when no supervisor runs
     */
    void install();

    /** The scheduled pass: a daily check, and in AUTO mode the install inside the window. */
    void tick();
}
