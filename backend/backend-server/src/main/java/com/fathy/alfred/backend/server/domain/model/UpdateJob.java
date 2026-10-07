package com.fathy.alfred.backend.server.domain.model;

/**
 * The supervisor's account of an update it was asked to install: downloading (with progress), verifying the
 * checksum, the installer running - or why it stopped. {@code IDLE} when none was asked for since it started.
 */
public record UpdateJob(State state, String version, long downloadedBytes, long totalBytes, String error) {

    public enum State { IDLE, DOWNLOADING, VERIFYING, INSTALLING, FAILED }

    public static UpdateJob idle() {
        return new UpdateJob(State.IDLE, "", 0, 0, "");
    }
}
