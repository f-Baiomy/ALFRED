package com.fathy.alfred.backend.calls.domain.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * How one outbound call's wall clock divided up, as measured by the proxy (see
 * proxy/log_and_route.py's _phase_timing).
 *
 * <p>This is what turns "the supplier took 5.7s" into a diagnosis. A large {@code ttfbMs} means the
 * upstream is thinking; a large {@code downloadMs} means the payload is big; a large
 * {@code connectMs}+{@code tlsMs} share means connections are not being reused, which is a fix on
 * our side rather than theirs.
 *
 * <p>Every field is nullable and normally several are null at once. mitmproxy REUSES server
 * connections, and when it does, the handshake belongs to some earlier call - so
 * {@code connectMs}/{@code tlsMs} are only populated when the handshake actually happened during
 * this request, with {@code reusedConnection} recording which case it was. A call logged before
 * this feature existed has the whole record null, which every reader must treat as "not measured"
 * rather than as zero.
 */
public record CallTiming(
        @JsonProperty("connect_ms") Double connectMs,
        @JsonProperty("tls_ms") Double tlsMs,
        @JsonProperty("ttfb_ms") Double ttfbMs,
        @JsonProperty("download_ms") Double downloadMs,
        @JsonProperty("reused_connection") Boolean reusedConnection
) {
    /**
     * True when there is nothing worth persisting - every measurement came back null.
     *
     * <p>{@code @JsonIgnore} because Jackson treats any {@code isX()} on a record as a property:
     * without it this serializes as an extra {@code "empty": false} field on every call in every
     * list response (confirmed on the wire), which is an implementation detail leaking into the
     * API.
     */
    @JsonIgnore
    public boolean isEmpty() {
        return connectMs == null && tlsMs == null && ttfbMs == null && downloadMs == null && reusedConnection == null;
    }
}
