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
        com.fathy.alfred.backend.linksbridge.RemoteBoardData r = remote == null ? null : remote.getIfAvailable();
        if (r != null && cycleId != null && r.isRemote(cycleId)) {
            // specs/035: signed by the cycle's owner, the same way
            return r.cycleCalls(cycleId, 20_000).stream().filter(c -> c.callId().equals(callId) && direction.equals(c.direction()))
                    .map(com.fathy.alfred.backend.board.domain.model.CycleCall::signature).filter(java.util.Objects::nonNull).findFirst();
        }
        String resolverDirection = "out".equals(direction) ? "outbound" : "inbound";
        try {
            // The summary has everything a signature needs; the headers and bodies of a big call are never loaded for it.
            // The summary lookup can miss a call that exists (see CallRefResolver), so a miss falls back to the full one.
            return calls.head(resolverDirection, callId, cycleId)
                    .filter(h -> h.method() != null && h.url() != null)
                    .map(h -> signatureFor(h.method(), h.url(), h.status()))
                    .or(() -> calls.resolve(resolverDirection, callId, cycleId)
                            .filter(c -> c.method() != null && c.url() != null)
                            .map(c -> signatureFor(c.method(), c.url(), c.responseStatus())));
        } catch (RuntimeException e) {
            return Optional.empty(); // a call that cannot be read gives no signature, never a failed save
        }
    }

    private org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.linksbridge.RemoteBoardData> remote;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setRemote(org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.linksbridge.RemoteBoardData> remote) {
        this.remote = remote;
    }

    private String signatureFor(String method, String url, Integer status) {
        return signalOf(status) + "|" + endpoints.endpointOf(method, url);
    }

    static String signalOf(ResolvedCall call) {
        return signalOf(call.responseStatus());
    }

    private static String signalOf(Integer status) {
        if (status == null) {
            return "error";
        }
        if (status >= 500) {
            return "5xx";
        }
        return status >= 400 ? "4xx" : "ok";
    }
}
