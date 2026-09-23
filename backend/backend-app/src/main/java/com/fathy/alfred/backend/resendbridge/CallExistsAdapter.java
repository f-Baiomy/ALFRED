package com.fathy.alfred.backend.resendbridge;

import com.fathy.alfred.backend.resend.application.port.out.CallExistsPort;
import org.springframework.stereotype.Component;

/**
 * Bridges backend-resend's CallExistsPort to the call slices, so the resend controller can
 * confirm a call id is still known (outbound or inbound) without backend-resend importing
 * either slice directly - same reasoning as interceptionbridge's RecordedCallLookupAdapter:
 * backend-resend must not depend on any call slice, and this composition root is the only
 * place allowed to know them all.
 */
@Component
public class CallExistsAdapter implements CallExistsPort {

    private final com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase outbound;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase inbound;

    public CallExistsAdapter(com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase outbound,
                              com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase inbound) {
        this.outbound = outbound;
        this.inbound = inbound;
    }

    @Override
    public boolean exists(String callId) {
        return outbound.getDetail(callId).isPresent() || inbound.getDetail(callId).isPresent();
    }
}
