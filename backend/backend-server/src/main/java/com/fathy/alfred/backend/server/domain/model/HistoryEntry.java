package com.fathy.alfred.backend.server.domain.model;

import java.time.Instant;
import java.util.List;

/**
 * One change to .env (FR-034). Secret values are never recorded: their before/after read "set" / "changed".
 *
 * @param sourceDetail the client address (UI), the OS user (CLI), the Docker folder (IMPORT) or the reverted id (REVERT)
 * @param snapshotFile name of the copy of .env taken before this change, under data/env-history/
 */
public record HistoryEntry(long id, Instant at, HistorySource source, String sourceDetail, List<Change> changes,
                           String snapshotFile) {

    public enum HistorySource { UI, CLI, HAND_EDIT, INSTALL, UPGRADE, IMPORT, REVERT }

    public record Change(String key, String before, String after) {
    }

    public HistoryEntry {
        changes = List.copyOf(changes);
    }
}
