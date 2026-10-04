package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;

import java.util.List;
import java.util.Map;

/** The ◆ DB chips of the calls on screen. A call with no entry was not captured. */
public interface GetCallDbSummariesUseCase {

    int MAX_IDS = 500;

    Map<String, CallDbSummary> summaries(List<String> callIds);
}
