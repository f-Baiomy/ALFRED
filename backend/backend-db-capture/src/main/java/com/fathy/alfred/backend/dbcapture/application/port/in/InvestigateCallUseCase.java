package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.RecordedQueryRequest;
import com.fathy.alfred.backend.dbcapture.domain.model.RecordedQueryResult;
import com.fathy.alfred.backend.dbcapture.domain.model.TableSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.TraceHit;

import java.util.List;
import java.util.Optional;

/** The window's investigation tools over one call: search/SQL over rows and statements, value tracing, the Tables view. */
public interface InvestigateCallUseCase {

    int MAX_PAGE = 1000;

    /** Empty when the statement does not exist. */
    Optional<RecordedQueryResult> queryRows(long statementId, String part, RecordedQueryRequest request);

    RecordedQueryResult queryStatements(String callId, RecordedQueryRequest request);

    List<TraceHit> trace(String callId, String value);

    List<TableSummary> tables(String callId);
}
