package com.fathy.alfred.backend.interceptionbridge;

import com.fathy.alfred.backend.callrefbridge.CallRefResolver;
import com.fathy.alfred.backend.interception.application.port.out.RecordedCallLookupPort;
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
 * <p>Finding the call is CallRefResolver's job (shared with resendbridge); this only projects the
 * response half. It uses the tolerant {@link CallRefResolver#resolve}, since answering needs
 * nothing from the call's summary.
 */
@Component
public class RecordedCallLookupAdapter implements RecordedCallLookupPort {

    private final CallRefResolver resolver;

    public RecordedCallLookupAdapter(CallRefResolver resolver) {
        this.resolver = resolver;
    }

    @Override
    public Optional<RecordedResponse> find(String direction, String callId, String cycleId) {
        return resolver.resolve(direction, callId, cycleId)
                .flatMap(call -> response(call.responseStatus(), call.responseHeaders(), call.responseBody()));
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
