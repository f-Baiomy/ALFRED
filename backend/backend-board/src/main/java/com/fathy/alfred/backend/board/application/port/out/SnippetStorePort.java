package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.Snippet;
import com.fathy.alfred.backend.board.domain.model.SnippetShot;
import com.fathy.alfred.backend.board.domain.model.SnippetState;
import com.fathy.alfred.backend.board.domain.model.SnippetVersion;

import java.util.List;
import java.util.Optional;

/** Pages, their versions, saved state and shots (specs/017) - in board.db, beside the cards they belong to. */
public interface SnippetStorePort {

    /** Saves a new page with its version 1. */
    void insert(Snippet snippet);

    /** Saves the page as given; when {@code newVersion} the source is also kept as that version. */
    void update(Snippet snippet, boolean newVersion);

    /** Removes the page with its versions, state and shots. */
    boolean delete(String id);

    Optional<Snippet> find(String id);

    /** The owner's pages, without source, in tab order. */
    List<Snippet> list(Snippet.Owner owner, String ownerId);

    /** Newest first, without source. */
    List<SnippetVersion> versions(String id);

    Optional<SnippetVersion> version(String id, int version);

    List<SnippetState> state(String snippetId);

    Optional<SnippetState> state(String snippetId, String key);

    /** Sets a value (keeping the one before in its history); {@code cardId}/{@code cycleId} say what it goes with. */
    void putState(SnippetState value, String cardId, String cycleId);

    boolean deleteState(String snippetId, String key);

    /** Earlier values of one key, newest first. */
    List<SnippetState> stateHistory(String snippetId, String key, int limit);

    void putShot(SnippetShot shot, String cardId, String cycleId);

    /** The newest shot. */
    Optional<SnippetShot> shot(String snippetId);

    /** A cycle was deleted: its pages and every snippet's state and shots kept for it go. */
    void cycleRemoved(String cycleId);
}
