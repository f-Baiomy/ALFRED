package com.fathy.alfred.backend.internalcalls.adapter.in.web.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fathy.alfred.backend.internalcalls.domain.model.CallInterception;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;

/**
 * POST /internal-calls/webhook/{id}/complete's body, plus the proxy's own wall-clock duration
 * measurement. Usually exactly one of {@code response}/{@code error} is set.
 */
public record CompleteInternalCallRequestDto(
        ResponseData response,
        String error,
        @JsonProperty("duration_ms") Double durationMs,
        /** What an interception rule did, sent by the reverse proxy only when a rule touched the call. */
        CallInterception interception,
        /** Whether this call actually reached a real external system - only known once it settles. Drives Relive's Live-calls log (FR-015b). */
        @JsonProperty("reached_upstream") Boolean reachedUpstream,
        /**
         * The call as the proxy saw it at request time - original_url, url, method, timestamp, service_name,
         * session_id, operation_id; no headers or body. Lets a call whose prepare never reached the backend still be
         * stored as that call. Null from an older proxy.
         */
        @Valid CallIdentityDto call
) {

    /** Bounded (FR-015): the proxy's view of a URL and method, never a body - anything larger is not a real call. */
    public record CallIdentityDto(
            @Size(max = 8192) @JsonProperty("original_url") String originalUrl,
            @Size(max = 8192) String url,
            @Size(max = 16) String method,
            String timestamp,
            @JsonProperty("service_name") String serviceName,
            @JsonProperty("session_id") String sessionId,
            @JsonProperty("operation_id") String operationId
    ) {
    }

}
