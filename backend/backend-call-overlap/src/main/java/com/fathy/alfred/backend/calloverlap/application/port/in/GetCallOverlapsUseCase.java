package com.fathy.alfred.backend.calloverlap.application.port.in;

import com.fathy.alfred.backend.calloverlap.domain.model.CallOverlapEntry;
import com.fathy.alfred.backend.calloverlap.domain.model.CallOverlapQuery;

import java.util.List;

/**
 * Inbound port: the merged, windowed, filtered list of external + internal calls GET
 * /call-overlaps serves. No containment/nesting/sort logic here or in any implementation - the
 * frontend does that against the flat list this returns.
 */
public interface GetCallOverlapsUseCase {

    List<CallOverlapEntry> getOverlaps(CallOverlapQuery query);
}
