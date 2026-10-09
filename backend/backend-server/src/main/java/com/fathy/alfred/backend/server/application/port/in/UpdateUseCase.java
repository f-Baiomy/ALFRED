package com.fathy.alfred.backend.server.application.port.in;

import com.fathy.alfred.backend.server.domain.model.UpdateStatus;

/** Check for updates and install one (the Server card's update row, {@code alfred update}). */
public interface UpdateUseCase {

    /** The last check's result, without reading the feed. */
    UpdateStatus status();

    /** Reads the feed now. Never throws: a failed check is reported in {@link UpdateStatus#error()}. */
    UpdateStatus check();

    /** Installs the newest available release (or goes on with a paused download of it). */
    default void install() {
        install(null);
    }

    /**
     * Asks the supervisor to download, verify and run the installer of {@code version} - one of
     * {@link UpdateStatus#releases()}; null or blank means the newest. A paused download of another release is
     * dropped by the supervisor (its pieces are of no use to this one).
     *
     * @throws IllegalStateException in Docker mode, with no update available, for a version the feed does not list
     *                               as newer, or when no supervisor runs
     */
    void install(String version);

    /**
     * Stops the download in progress and keeps its pieces for the next install of the same release.
     *
     * @throws IllegalStateException when nothing is downloading
     */
    void pause();

    /**
     * Stops the download in progress, or drops a paused one, and deletes what was downloaded.
     *
     * @throws IllegalStateException when nothing is downloading or paused
     */
    void cancel();

    /** The scheduled pass: a daily check, and in AUTO mode the install inside the window. */
    void tick();
}
