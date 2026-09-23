package com.fathy.alfred.backend.resendbridge;

import com.fathy.alfred.backend.resend.application.port.out.CallSourcePort;
import com.fathy.alfred.backend.resend.domain.model.StoredCall;
import com.fathy.alfred.backend.sessioncycles.application.port.in.FindCapturedCallUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.FindCapturedInternalCallUseCase;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * Bridges backend-resend's CallSourcePort to the call slices (live log) and session-cycles
 * (a cycle's captured calls) - backend-resend must not depend on any of them directly, and this
 * composition root is the only place allowed to know them all. Same reasoning as
 * interceptionbridge.RecordedCallLookupAdapter.
 *
 * <p>The two call slices' detail use cases only carry request/response - a resend also needs
 * method, original_url and service_name, which is why this uses each slice's own
 * {@code FindCallUseCase}/{@code FindCapturedCallUseCase} (a single indexed lookup returning the
 * full record) instead.
 */
@Component
public class CallSourceAdapter implements CallSourcePort {

    private final com.fathy.alfred.backend.calls.application.port.in.FindCallUseCase outbound;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.FindCallUseCase inbound;
    private final FindCapturedCallUseCase capturedOutbound;
    private final FindCapturedInternalCallUseCase capturedInbound;

    public CallSourceAdapter(com.fathy.alfred.backend.calls.application.port.in.FindCallUseCase outbound,
                              com.fathy.alfred.backend.internalcalls.application.port.in.FindCallUseCase inbound,
                              FindCapturedCallUseCase capturedOutbound,
                              FindCapturedInternalCallUseCase capturedInbound) {
        this.outbound = outbound;
        this.inbound = inbound;
        this.capturedOutbound = capturedOutbound;
        this.capturedInbound = capturedInbound;
    }

    @Override
    public Optional<StoredCall> load(String direction, String callId, String cycleId) {
        if ("outbound".equals(direction)) {
            Optional<com.fathy.alfred.backend.calls.domain.model.CallRecord> record = cycleId == null
                    ? outbound.find(callId)
                    : capturedOutbound.findCaptured(cycleId, callId).map(captured -> captured.call());
            return record.map(CallSourceAdapter::toStoredCallOutbound);
        }
        if ("inbound".equals(direction)) {
            Optional<com.fathy.alfred.backend.internalcalls.domain.model.CallRecord> record = cycleId == null
                    ? inbound.find(callId)
                    : capturedInbound.findCaptured(cycleId, callId).map(captured -> captured.call());
            return record.map(CallSourceAdapter::toStoredCallInbound);
        }
        return Optional.empty();
    }

    private static StoredCall toStoredCallOutbound(com.fathy.alfred.backend.calls.domain.model.CallRecord record) {
        var request = record.request();
        return new StoredCall("outbound", record.id(), record.method(),
                record.originalUrl() != null ? record.originalUrl() : record.url(),
                request == null ? null : request.headers(),
                request == null ? null : request.body(),
                record.serviceName());
    }

    private static StoredCall toStoredCallInbound(com.fathy.alfred.backend.internalcalls.domain.model.CallRecord record) {
        var request = record.request();
        return new StoredCall("inbound", record.id(), record.method(),
                record.originalUrl() != null ? record.originalUrl() : record.url(),
                request == null ? null : request.headers(),
                request == null ? null : request.body(),
                record.serviceName());
    }
}
