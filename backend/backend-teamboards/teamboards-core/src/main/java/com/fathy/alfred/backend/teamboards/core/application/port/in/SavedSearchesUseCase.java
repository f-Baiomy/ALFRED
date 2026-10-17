package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase.SearchIn;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;

import java.time.Instant;
import java.util.List;

/**
 * Saved searches (specs/029): a named search of one connection - text, every filter, Open only, sort and Show - shown as
 * a pill above the Team tab's results; one click runs it. Kept in teamboards.db so every browser (and Claude, read-only)
 * sees the same ones. Only the user saves, changes, moves or deletes one.
 */
public interface SavedSearchesUseCase {

    int MAX_PER_CONNECTION = 50;
    int MAX_NAME = 80;

    /** One saved search; {@code lastCount}: the matches the last time it ran (null: never). */
    record Saved(long id, String conn, String name, SearchIn query, int position, Integer lastCount, Instant updatedAt) {
    }

    List<Saved> list(String conn);

    Saved get(long id);

    Saved create(Who who, String conn, String name, SearchIn query);

    /** A new name, a new search, or both (null: unchanged). */
    Saved update(Who who, long id, String name, SearchIn query);

    /** One place left ({@code -1}) or right ({@code +1}); the whole list, in its new order. */
    List<Saved> move(Who who, long id, int by);

    boolean delete(Who who, long id);

    /** Records how many matched when it last ran (from a search naming it). */
    void counted(long id, int total);
}
