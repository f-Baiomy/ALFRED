package com.fathy.alfred.backend.server.application.port.in;

import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.SettingsChange;

import java.util.List;

/** The history of .env (FR-034/035). Reverting never writes: it returns the edits that would restore the old values. */
public interface SettingsHistoryUseCase {

    int MAX_LIMIT = 50;

    /** Newest first; {@code limit} is clamped to 1..50. */
    List<HistoryEntry> history(int limit);

    /**
     * The edits that put every setting entry {@code id} changed back to its value before that entry.
     *
     * @throws java.util.NoSuchElementException when the entry is no longer kept
     */
    List<SettingsChange.Edit> revert(long id);
}
