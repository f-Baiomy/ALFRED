package com.fathy.alfred.backend.server.application.port.out;

import java.util.Optional;

/**
 * What the checks need to know about this machine (FR-030). Every method answers within a short timeout; none reads
 * the content of any file.
 */
public interface MachinePort {

    /** Who listens on {@code port}: empty when it is free, "process unknown" when busy but the owner is not visible. */
    Optional<String> portOwner(int port);

    record FolderInfo(boolean exists, boolean readable, int logFiles, long newestModifiedMillis) {
    }

    FolderInfo folder(String path);

    long freeDiskBytes();

    long totalMemoryBytes();

    long freeMemoryBytes();

    /** @param statusCode the HTTP status the app answered with, or -1 when nothing answered */
    record AppHealth(int statusCode, long millis, String reason) {
        public boolean answering() {
            return statusCode > 0;
        }
    }

    AppHealth appHealth(int port);
}
