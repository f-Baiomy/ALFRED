package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;

import java.util.List;
import java.util.Map;

/** The ◆ DB chips of the calls on screen. A call with no entry was not captured. */
public interface GetCallDbSummariesUseCase {

    int MAX_IDS = 500;

    Map<String, CallDbSummary> summaries(List<String> callIds);

    /**
     * The calls of these whose agent sent nothing although they asked for capture, with what they asked for
     * ("db,logs,redis" or part of it). Only calls completed at least {@link #SILENT_AFTER_SECONDS} ago - the agent's
     * batches can arrive a little after the call itself.
     */
    default Map<String, String> silentCalls(List<String> callIds) {
        return Map.of();
    }

    int SILENT_AFTER_SECONDS = 20;
}
