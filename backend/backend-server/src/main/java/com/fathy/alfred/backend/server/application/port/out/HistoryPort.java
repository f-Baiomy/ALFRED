package com.fathy.alfred.backend.server.application.port.out;

import com.fathy.alfred.backend.server.domain.model.HistoryEntry;

import java.util.List;
import java.util.Optional;

/** Every change to .env, newest last, with the .env content before each (FR-034). Keeps the last 50. */
public interface HistoryPort {

    /** @return the new entry's id */
    long append(HistoryEntry.HistorySource source, String sourceDetail, List<HistoryEntry.Change> changes,
                String contentBefore, String contentAfter);

    /** Newest first, at most {@code limit}. */
    List<HistoryEntry> recent(int limit);

    Optional<HistoryEntry> find(long id);

    /** The .env content before entry {@code id}, while its snapshot is still kept. */
    Optional<String> contentBefore(long id);

    /** The .env content after the newest entry: what Alfred last wrote or saw. Empty before the first entry. */
    Optional<String> lastKnownContent();
}
