package com.fathy.alfred.backend.logs.domain.model;

/**
 * How a watched folder is read.
 *
 * @param folder     the name of one {@code logs_watch_dirs} entry (mounted at /watch/‹name›)
 * @param pattern    file-name glob, e.g. {@code detail*.log} - rotated files such as {@code detail.log.1}
 *                   match too, because the glob is tried on the name with its rotation suffix removed
 * @param subfolders also watch the folders below it
 * @param start      what to load first: everything, the last N lines, or only lines written from now
 * @param lastLines  N for {@link Start#LAST}
 * @param perFile    N counted per file (true) or across all files, newest first (false)
 */
public record WatchOptions(String folder, String pattern, boolean subfolders, Start start, int lastLines, boolean perFile) {

    public enum Start { ALL, LAST, NEW }

    public static final int MAX_LAST_LINES = 10_000_000;
}
