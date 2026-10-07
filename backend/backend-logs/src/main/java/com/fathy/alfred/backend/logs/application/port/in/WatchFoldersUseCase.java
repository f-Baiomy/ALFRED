package com.fathy.alfred.backend.logs.application.port.in;

import com.fathy.alfred.backend.logs.application.port.out.WatchFoldersPort;

import java.util.List;

/** Watched folders (settings.properties {@code logs_watch_dirs}) and how changes in them are noticed. */
public interface WatchFoldersUseCase {

    /**
     * @param mode         "events" (the backend is notified by the kernel), "agent" (a host agent forwards the
     *                     OS notifications - Docker Desktop on Windows/macOS) or "off"
     * @param agentSeenAt  when the host agent last reported in (epoch ms), 0 = never since start
     */
    record Folders(List<WatchFoldersPort.Folder> folders, String mode, long agentSeenAt) {
    }

    Folders folders();

    List<WatchFoldersPort.WatchedFile> files(String folder, String pattern, boolean subfolders);

    /** A path below a watched folder changed (created, written, renamed or deleted). */
    void changed(String folder, String relative);

    /** Changes may have been missed (event queue overflow, agent reconnected): re-check every file of the folder. */
    void rescan(String folder);

    /** The host agent reported in (it then rescans: nothing written while it was away is missed). */
    void agentSeen();

    /** One live (non-archive) file being followed: its watched folder's name and its path below it. */
    record FollowedFile(String folder, String path) {
    }

    /**
     * The live files of every active watch. The host agent checks their size itself: Windows does not
     * report writes to a file its writer keeps open (a logger) until the file is closed.
     */
    List<FollowedFile> followed();

    /**
     * Replaces the watched folders while running (ALFRED_LOGS_WATCH_DIRS saved in the Server section, a LIVE setting):
     * the folders' change notifications are re-registered and every followed folder is rescanned.
     */
    void replaceFolders(String watchDirs);

    /** Published after {@link #replaceFolders}: the change-notification adapter re-registers its folders. */
    record FoldersReplaced() {
    }
}
