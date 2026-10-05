package com.fathy.alfred.backend.triagebridge;

import com.fathy.alfred.backend.calls.application.port.out.NewCallObserverPort;
import com.fathy.alfred.backend.internalcalls.application.port.out.NewInternalCallObserverPort;
import com.fathy.alfred.backend.triage.application.port.in.RecordCallAttentionUseCase;
import com.fathy.alfred.backend.triage.domain.model.CallDirection;
import com.fathy.alfred.backend.triage.domain.model.ObservedCall;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Feeds triage's saved marks from the proxy webhook pipeline: every inbound and outbound call, when it is intercepted
 * and when it completes. Lives in backend-app because backend-triage may not depend on either calls slice (ArchUnit);
 * each slice's own CallRecord is translated into triage's slice-agnostic {@link ObservedCall} here. The use case only
 * queues the call, so the webhook is not slowed down. Never captures a call into anything, so it returns no ids.
 */
@Component
public class TriageCallObserverAdapter implements NewCallObserverPort, NewInternalCallObserverPort {

    private final RecordCallAttentionUseCase record;

    public TriageCallObserverAdapter(RecordCallAttentionUseCase record) {
        this.record = record;
    }

    /** Legacy single-shot path - the call arrives already fully resolved. */
    @Override
    public List<String> onNewCall(com.fathy.alfred.backend.calls.domain.model.CallRecord call) {
        record.callObserved(outbound(call));
        return List.of();
    }

    @Override
    public List<String> onCallPrepared(com.fathy.alfred.backend.calls.domain.model.CallRecord call) {
        record.callObserved(outbound(call));
        return List.of();
    }

    @Override
    public List<String> onCallCompleted(com.fathy.alfred.backend.calls.domain.model.CallRecord call) {
        record.callObserved(outbound(call));
        return List.of();
    }

    @Override
    public void onCallPrepared(com.fathy.alfred.backend.internalcalls.domain.model.CallRecord call) {
        record.callObserved(inbound(call));
    }

    @Override
    public List<String> onCallCompleted(com.fathy.alfred.backend.internalcalls.domain.model.CallRecord call) {
        record.callObserved(inbound(call));
        return List.of();
    }

    static ObservedCall outbound(com.fathy.alfred.backend.calls.domain.model.CallRecord call) {
        var response = call.response();
        return new ObservedCall(call.id(), CallDirection.OUTBOUND, null, call.parentCallId(), call.method(), call.url(),
                response == null ? null : response.status(), call.error(), call.timestamp(), call.durationMs(),
                call.state() == null ? null : call.state().name(), response == null ? null : response.body());
    }

    static ObservedCall inbound(com.fathy.alfred.backend.internalcalls.domain.model.CallRecord call) {
        var response = call.response();
        return new ObservedCall(call.id(), CallDirection.INBOUND, call.serviceName(), null, call.method(), call.url(),
                response == null ? null : response.status(), call.error(), call.timestamp(), call.durationMs(),
                call.state() == null ? null : call.state().name(), response == null ? null : response.body());
    }
}
