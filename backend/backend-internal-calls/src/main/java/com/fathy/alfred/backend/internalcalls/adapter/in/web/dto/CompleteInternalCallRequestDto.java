package com.fathy.alfred.backend.internalcalls.adapter.in.web.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;

/**
 * POST /internal-calls/webhook/{id}/complete's body, plus the proxy's own wall-clock duration
 * measurement. Usually exactly one of {@code response}/{@code error} is set.
 */
public record CompleteInternalCallRequestDto(
        ResponseData response,
        String error,
        @JsonProperty("duration_ms") Double durationMs
) {
}
