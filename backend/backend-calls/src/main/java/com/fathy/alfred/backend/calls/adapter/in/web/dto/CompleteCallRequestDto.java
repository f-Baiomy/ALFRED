package com.fathy.alfred.backend.calls.adapter.in.web.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;

/** POST /calls/webhook/{id}/complete's body - exactly one of {@code response}/{@code error} is set, plus the proxy's own wall-clock duration measurement (see CallLifecycleStatus's doc). */
public record CompleteCallRequestDto(
        ResponseData response,
        String error,
        @JsonProperty("duration_ms") Double durationMs
) {
}
