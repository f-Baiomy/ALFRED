package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.CallFacts;
import com.fathy.alfred.backend.board.domain.model.CycleCall;

import java.util.Optional;
import java.util.Set;

/**
 * What a re-test reads about a call (specs/016): its statements per table, its log line counts, its duration and the
 * response values a SAME_RESPONSE expectation names, and a card's original call found by its mention ref. Implemented in
 * backend-app/boardbridge over the inbound calls, session cycles, database capture and caught log lines.
 */
public interface CallFactsPort {

    /** The facts of a live call ({@code cycleId} null) or of a call a cycle captured. Empty when the call is gone. */
    Optional<CallFacts> facts(String callId, String cycleId, Set<String> jsonPaths);

    /** A call mentioned as {@code in:<id>} or {@code in:<id>@<cycleId>}, signed. Empty when it is gone. */
    Optional<CycleCall> call(String ref);
}
