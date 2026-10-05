package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.CallStatementFailures;

import java.util.List;
import java.util.Map;

/** The failed statements of many calls in one indexed read. A call with no entry had no failed statement. */
public interface FindStatementFailuresUseCase {

    int MAX_IDS = 500;

    /** @throws IllegalArgumentException for more than {@link #MAX_IDS} ids */
    Map<String, CallStatementFailures> failures(List<String> callIds);
}
