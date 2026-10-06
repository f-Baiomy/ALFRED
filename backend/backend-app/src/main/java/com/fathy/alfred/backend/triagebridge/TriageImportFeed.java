package com.fathy.alfred.backend.triagebridge;

import com.fathy.alfred.backend.sessioncycles.application.port.out.CopiedCallsObserverPort;
import com.fathy.alfred.backend.triage.application.port.in.RecordCallAttentionUseCase;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Calls copied into a session cycle - an import, or calls added from elsewhere - get their triage mark like recorded
 * calls (specs/010-mcp-log-investigation, FR-018): without it an imported call was invisible to triage and to problem
 * calls. Copying a call triage already knows rewrites its mark with the same facts; its counts and signals are kept.
 */
@Component
public class TriageImportFeed implements CopiedCallsObserverPort {

    private final RecordCallAttentionUseCase record;

    /**
     * Lazy: triage reads the ids cycles hold (TriageRetainedCallIdsAdapter → session cycles), and session cycles tell this
     * feed what was copied in - resolved on first use, the two never wait for each other at start-up.
     */
    public TriageImportFeed(@Lazy RecordCallAttentionUseCase record) {
        this.record = record;
    }

    @Override
    public void inboundCopied(String cycleId, List<com.fathy.alfred.backend.internalcalls.domain.model.CallRecord> calls) {
        calls.forEach(call -> record.callObserved(TriageCallObserverAdapter.inbound(call)));
    }

    @Override
    public void outboundCopied(String cycleId, List<com.fathy.alfred.backend.calls.domain.model.CallRecord> calls) {
        calls.forEach(call -> record.callObserved(TriageCallObserverAdapter.outbound(call)));
    }
}
