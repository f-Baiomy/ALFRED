package com.fathy.alfred.backend.server.domain.model;

/**
 * The supervisor's account of an update it was asked to install: downloading (with progress), verifying the
 * checksum, the installer running - or why it stopped. {@code IDLE} when none was asked for since it started.
 * {@code PAUSED} keeps the pieces already downloaded on disk (the next install of the same release fetches only the
 * missing ones, {@code resumedBytes}); {@code cached} means the installer came from the download cache, no download.
 */
public record UpdateJob(State state, String version, long downloadedBytes, long totalBytes, String error,
                        boolean cached, long resumedBytes) {

    public enum State { IDLE, DOWNLOADING, VERIFYING, INSTALLING, PAUSED, FAILED }

    public UpdateJob(State state, String version, long downloadedBytes, long totalBytes, String error) {
        this(state, version, downloadedBytes, totalBytes, error, false, 0);
    }

    public static UpdateJob idle() {
        return new UpdateJob(State.IDLE, "", 0, 0, "");
    }

    /** Downloading, checking or installing: a second install is refused until it ends (a pause ends it). */
    public boolean running() {
        return state == State.DOWNLOADING || state == State.VERIFYING || state == State.INSTALLING;
    }
}
