package com.fathy.alfred.backend.interception.application.port.out;

import java.util.Map;
import java.util.Optional;

/**
 * Reads the response of a call Alfred has already logged, outbound or inbound, live or captured in
 * a session cycle. Implemented in backend-app, the one place allowed to know the call slices -
 * interception depends on none of them.
 */
public interface RecordedCallLookupPort {

    /**
     * @param direction "outbound" or "inbound"
     * @param cycleId   the session cycle the call was captured in, or null for the live log
     * @return empty when the call does not exist or never got a response
     */
    Optional<RecordedResponse> find(String direction, String callId, String cycleId);

    /** @param body the body as logged: decoded text, so any content-encoding no longer applies. */
    record RecordedResponse(int status, Map<String, String> headers, byte[] body) {
        public RecordedResponse {
            headers = headers == null ? Map.of() : Map.copyOf(headers);
            body = body == null ? new byte[0] : body;
        }
    }
}
