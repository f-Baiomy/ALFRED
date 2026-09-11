package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.CallOverlapEntry;
import com.fathy.alfred.backend.sessioncycles.domain.model.CallOverlapQuery;

import java.util.List;
import java.util.Optional;

/**
 * Inbound port: the merged, windowed, filtered list of this cycle's own captured external +
 * internal calls GET /session-cycles/{id}/call-overlaps serves - scoped to one cycle's captured-
 * calls stores, not the global live calls tables (see backend-call-overlap's GetCallOverlapsUseCase
 * for that). No containment/nesting/sort logic here or in any implementation - the frontend does
 * that against the flat list this returns.
 */
public interface ListCallOverlapsUseCase {

    /** Empty Optional means the cycle itself doesn't exist (404) - same convention as ListCapturedCallsUseCase. */
    Optional<List<CallOverlapEntry>> listCallOverlaps(String cycleId, CallOverlapQuery query);
}
