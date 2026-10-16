package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BriefComment;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** Where a cycle brief's comments live (specs/024). They go with the cycle's brief when the cycle is removed. */
public interface BriefCommentStorePort {

    /** Every comment of the cycle, oldest first (at most a few thousand). */
    List<BriefComment> briefComments(String cycleId);

    Optional<BriefComment> briefComment(long id);

    /** Saves a new comment and gives its id (the record's own id is ignored). */
    long addBriefComment(BriefComment comment);

    /** Resolves ({@code at} set) or reopens ({@code at} null) a thread. */
    boolean resolveBriefComment(long id, Instant at, Actor by);

    /** Drops a comment's suggested rewording (applied or dismissed). */
    boolean clearBriefSuggestion(long id);

    /** The quote a thread is about, after its passage was reworded. */
    void requoteBriefComment(long id, String quote);
}
