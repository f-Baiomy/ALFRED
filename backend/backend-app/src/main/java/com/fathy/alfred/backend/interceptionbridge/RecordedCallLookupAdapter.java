package com.fathy.alfred.backend.interceptionbridge;

import com.fathy.alfred.backend.interception.application.port.out.RecordedCallLookupPort;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * Bridges backend-interception's RecordedCallLookupPort to the call slices, so a rule can answer
 * with a response Alfred logged earlier - outbound or inbound, live or captured in a session
 * cycle. Lives in backend-app for the same reason as CallFilterAdapter: interception must not
 * depend on any call slice, and this composition root is the only place allowed to know them all.
 *
 * <p>The two call slices have identically named use cases and records, so they are referred to by
 * their full names here rather than imported.
 */
@Component
public class RecordedCallLookupAdapter implements RecordedCallLookupPort {

    private final com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase outbound;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase inbound;
    private final GetCapturedCallDetailUseCase capturedOutbound;
    private final GetCapturedInternalCallDetailUseCase capturedInbound;

    public RecordedCallLookupAdapter(com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase outbound,
                                     com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase inbound,
                                     GetCapturedCallDetailUseCase capturedOutbound,
                                     GetCapturedInternalCallDetailUseCase capturedInbound) {
        this.outbound = outbound;
        this.inbound = inbound;
        this.capturedOutbound = capturedOutbound;
        this.capturedInbound = capturedInbound;
    }

    @Override
    public Optional<RecordedResponse> find(String direction, String callId, String cycleId) {
        if ("outbound".equals(direction)) {
            return (cycleId == null ? outbound.getDetail(callId) : capturedOutbound.getDetail(cycleId, callId))
                    .map(com.fathy.alfred.backend.calls.domain.model.CallDetail::response)
                    .flatMap(r -> response(r.status(), r.headers(), r.body()));
        }
        if ("inbound".equals(direction)) {
            return (cycleId == null ? inbound.getDetail(callId) : capturedInbound.getDetail(cycleId, callId))
                    .map(com.fathy.alfred.backend.internalcalls.domain.model.CallDetail::response)
                    .flatMap(r -> response(r.status(), r.headers(), r.body()));
        }
        return Optional.empty();
    }

    /** A call that never got a response (still in flight, or failed) has nothing to answer with. */
    private static Optional<RecordedResponse> response(Integer status, Map<String, String> headers, String body) {
        if (status == null) {
            return Optional.empty();
        }
        Map<String, String> clean = new LinkedHashMap<>();
        if (headers != null) {
            headers.forEach((name, value) -> {
                if (name != null && value != null) {
                    clean.put(name, value);
                }
            });
        }
        return Optional.of(new RecordedResponse(status, clean,
                body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8)));
    }
}
