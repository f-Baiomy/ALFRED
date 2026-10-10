package com.fathy.alfred.backend.storage;

import com.fathy.alfred.backend.internalcalls.application.port.out.InternalCallFilterPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import org.springframework.stereotype.Component;

import java.util.List;

/** Inbound side of "Stop recording": the endpoint rule, and the cascade for what the agent still sends for such a call. */
@Component
class InboundRecordingFilter implements InternalCallFilterPort {

    private final RecordingRules rules;
    private final CallDeletionCascade cascade;

    InboundRecordingFilter(RecordingRules rules, CallDeletionCascade cascade) {
        this.rules = rules;
        this.cascade = cascade;
    }

    @Override
    public boolean isRecorded(CallRecord call) {
        return rules.isRecorded("inbound", call.method(), call.url());
    }

    @Override
    public void notRecorded(String callId) {
        cascade.inboundRemoved(List.of(callId));
    }
}
