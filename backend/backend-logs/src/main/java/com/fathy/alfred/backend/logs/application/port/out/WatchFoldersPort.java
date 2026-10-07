package com.fathy.alfred.backend.logs.application.port.out;

import java.io.IOException;
import java.util.List;

/**
 * The folders listed in {@code logs_watch_dirs}, each mounted read-only at /watch/‹name›. Only for live
 * listening - uploads and server files use the separate /logs folder ({@link LogFilesPort}).
 */
public interface WatchFoldersPort {

    /**
     * @param hostPath  the folder on the host, as configured (shown to the user)
     * @param available false when the folder is configured but not mounted (restart needed)
     */
    record Folder(String name, String hostPath, boolean available) {
    }

    /**
     * @param path     absolute path inside the backend
     * @param relative path below the watched folder, with '/' separators
     * @param archive  a rotated copy (detail.log.1, detail.log.2026-10-03): read once, never followed -
     *                 the live file's rotation is followed by the live file's own reader
     */
    record WatchedFile(String path, String relative, long size, long modified, boolean archive) {
    }

    List<Folder> folders();

    /** Replaces the configured list ("name:path,..."), e.g. after it was saved in the Server section (native install). */
    default void replace(String watchDirs) {
        throw new UnsupportedOperationException("this watch-folder source cannot be changed while running");
    }

    /** Absolute folder path; IllegalArgumentException when the name is not a configured, mounted folder. */
    String dir(String folder);

    /** Files of a folder matching the pattern, live files first, then archives newest first. */
    List<WatchedFile> files(String folder, String pattern, boolean subfolders) throws IOException;

    /**
     * Whether one path below the folder matches, and how: null = not matched, otherwise the file
     * (with {@code archive} set). The file may have been deleted already (size 0).
     */
    WatchedFile match(String folder, String relative, String pattern, boolean subfolders);

    /**
     * Where the last {@code lines} complete lines of a file start.
     *
     * @param offset byte offset to start reading at (0 when the file has fewer lines)
     * @param lines  how many complete lines that window holds (fewer than asked when the file is shorter)
     */
    record LastLines(long offset, long lines) {
    }

    LastLines lastLines(String path, long lines) throws IOException;
}
