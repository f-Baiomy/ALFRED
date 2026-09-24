package com.fathy.alfred.backend.resendbridge;

import com.fathy.alfred.backend.callrefbridge.CallRefResolver;
import com.fathy.alfred.backend.resend.application.port.out.CallSourcePort;
import com.fathy.alfred.backend.resend.domain.model.StoredCall;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.Optional;

/**
 * Bridges backend-resend's CallSourcePort to the call slices - outbound or inbound, live or
 * captured in a session cycle. Lives in backend-app for the same reason as CallFilterAdapter and
 * RecordedCallLookupAdapter: resend must not depend on any call slice, and this composition root
 * is the only place allowed to know them all.
 *
 * <p>Finding the call is CallRefResolver's job (shared with interceptionbridge); this only projects
 * the request half. It uses {@link CallRefResolver#resolveListed}: a resend needs the summary's
 * method and url, so a call the summary lookup cannot find is treated as not found.
 */
@Component
public class CallSourceAdapter implements CallSourcePort {

    private final CallRefResolver resolver;

    public CallSourceAdapter(CallRefResolver resolver) {
        this.resolver = resolver;
    }

    @Override
    public Optional<StoredCall> load(String direction, String callId, String cycleId) {
        if (callId == null) {
            return Optional.empty();
        }
        return resolver.resolveListed(direction, callId, cycleId)
                .map(call -> new StoredCall(call.direction(), call.id(), call.method(), call.url(),
                        call.requestHeaders(), call.requestBody(), hostOf(call.url()), call.serviceName()));
    }

    private static String hostOf(String url) {
        try {
            return URI.create(url).getHost();
        } catch (RuntimeException e) {
            return null;
        }
    }
}
