package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.out.CallSignaturePort;
import com.fathy.alfred.backend.callrefbridge.CallRefResolver;
import com.fathy.alfred.backend.callrefbridge.ResolvedCall;
import com.fathy.alfred.backend.triage.application.port.in.NormalizeEndpointUseCase;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * A card's signature from the first call it mentions (research R12): the kind of outcome plus triage's endpoint
 * grouping, e.g. {@code 5xx|POST /api/orders/{n}}. Two cards with the same signature are about the same problem on the
 * same endpoint - the "looks like a closed card" hint and Claude's duplicate check compare these.
 */
@Component
public class BoardCallSignatureAdapter implements CallSignaturePort {

    private final CallRefResolver calls;
    private final NormalizeEndpointUseCase endpoints;

    public BoardCallSignatureAdapter(CallRefResolver calls, NormalizeEndpointUseCase endpoints) {
        this.calls = calls;
        this.endpoints = endpoints;
    }

    @Override
    public Optional<String> signatureOf(String direction, String callId, String cycleId) {
        if (callId == null || direction == null) {
            return Optional.empty();
        }
        String resolverDirection = "out".equals(direction) ? "outbound" : "inbound";
        try {
            return calls.resolve(resolverDirection, callId, cycleId)
                    .filter(c -> c.method() != null && c.url() != null)
                    .map(c -> signalOf(c) + "|" + endpoints.endpointOf(c.method(), c.url()));
        } catch (RuntimeException e) {
            return Optional.empty(); // a call that cannot be read gives no signature, never a failed save
        }
    }

    static String signalOf(ResolvedCall call) {
        Integer status = call.responseStatus();
        if (status == null) {
            return "error";
        }
        if (status >= 500) {
            return "5xx";
        }
        return status >= 400 ? "4xx" : "ok";
    }
}
