package com.fathy.alfred.backend.dbcapturebridge;

import com.fathy.alfred.backend.callrefbridge.CallRefResolver;
import com.fathy.alfred.backend.callrefbridge.ResolvedCall;
import com.fathy.alfred.backend.dbcapture.application.port.out.CallMetadataPort;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMetadata;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Database capture's view of who a recorded call was - method, path, status - for "written by" and a Redis key's
 * history (specs/011-redis-capture research R12). Redis commands belong to inbound calls, so the inbound slice is
 * asked first, then the outbound one; a call found in neither (aged out) is simply left out.
 */
@Component
public class CallMetadataAdapter implements CallMetadataPort {

    /** Calls looked up per request - a key's history page or one opened command needs only a few. */
    static final int MAX_LOOKUPS = 200;

    /**
     * Resolved on first use, not at start: the call slices reach database capture through InboundCallCompletionAdapter,
     * and database capture reaches them through here - a constructor dependency both ways is a bean cycle.
     */
    private final ObjectProvider<CallRefResolver> calls;

    public CallMetadataAdapter(ObjectProvider<CallRefResolver> calls) {
        this.calls = calls;
    }

    @Override
    public Map<String, CallMetadata> metadata(Set<String> callIds) {
        Map<String, CallMetadata> out = new LinkedHashMap<>();
        for (String id : callIds) {
            if (out.size() >= MAX_LOOKUPS) {
                break;
            }
            CallRefResolver resolver = calls.getObject();
            Optional<ResolvedCall> call = resolver.resolve("inbound", id, null).or(() -> resolver.resolve("outbound", id, null));
            call.ifPresent(c -> out.put(id, new CallMetadata(c.method(), path(c.url()), c.responseStatus())));
        }
        return out;
    }

    private static String path(String url) {
        if (url == null) {
            return null;
        }
        String p = url.replaceFirst("^https?://[^/]+", "");
        int q = p.indexOf('?');
        return q >= 0 ? p.substring(0, q) : p;
    }
}
