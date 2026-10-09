package com.fathy.alfred.backend.dbcapturebridge;

import com.fathy.alfred.backend.dbcapture.application.port.in.CompleteCallCaptureUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.out.NewInternalCallObserverPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Tells database capture when an inbound call completed - its status decides whether a failed statement was swallowed,
 * and a transport error while capture was still open means the application died mid-call. Observer of
 * backend-internal-calls, so neither slice knows the other.
 */
@Component
public class InboundCallCompletionAdapter implements NewInternalCallObserverPort {

    private final CompleteCallCaptureUseCase completeCallCapture;

    public InboundCallCompletionAdapter(CompleteCallCaptureUseCase completeCallCapture) {
        this.completeCallCapture = completeCallCapture;
    }

    @Override
    public List<String> onCallCompleted(CallRecord call) {
        completeCallCapture.callCompleted(call.id(), call.response() == null ? null : call.response().status(), call.error(), call.serviceName());
        return List.of();
    }
}
