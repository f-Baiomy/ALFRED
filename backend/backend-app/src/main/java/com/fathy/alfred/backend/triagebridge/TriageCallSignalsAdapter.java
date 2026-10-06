package com.fathy.alfred.backend.triagebridge;

import com.fathy.alfred.backend.dbcapture.application.port.out.CallSignalsObserverPort;
import com.fathy.alfred.backend.triage.application.port.in.RecordCallAttentionUseCase;
import com.fathy.alfred.backend.triage.domain.model.CallSignals;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * db-capture's log and database signals of a call into triage's saved mark of that call (specs/010-mcp-log-investigation)
 * - whenever db-capture says they may have changed. Neither slice knows the other. Calls captured before this version
 * are fed once by {@link TriageSignalsBackfill}.
 */
@Component
public class TriageCallSignalsAdapter implements CallSignalsObserverPort {

    private final RecordCallAttentionUseCase record;

    public TriageCallSignalsAdapter(RecordCallAttentionUseCase record) {
        this.record = record;
    }

    @Override
    public void signalsChanged(String callId, int logErrors, int logWarnings, int logExceptions, String logStatus, String logLevel,
                               List<String> dbFlags) {
        record.signals(callId, new CallSignals(logErrors, logWarnings, logExceptions, logStatus, logLevel, dbFlags));
    }
}
