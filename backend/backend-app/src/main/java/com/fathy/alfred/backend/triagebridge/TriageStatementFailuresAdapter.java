package com.fathy.alfred.backend.triagebridge;

import com.fathy.alfred.backend.dbcapture.application.port.out.StatementFailuresObserverPort;
import com.fathy.alfred.backend.triage.application.port.in.RecordCallAttentionUseCase;
import org.springframework.stereotype.Component;

/**
 * db-capture's failed-statement counts of a call, into triage's saved mark of that call - after each batch that gave
 * the call a failed statement, and when the call completes (when "swallowed" is decided). Neither slice knows the other.
 */
@Component
public class TriageStatementFailuresAdapter implements StatementFailuresObserverPort {

    private final RecordCallAttentionUseCase record;

    public TriageStatementFailuresAdapter(RecordCallAttentionUseCase record) {
        this.record = record;
    }

    @Override
    public void failuresChanged(String callId, int failedCount, int swallowedCount) {
        record.statementFailures(callId, failedCount, swallowedCount);
    }
}
