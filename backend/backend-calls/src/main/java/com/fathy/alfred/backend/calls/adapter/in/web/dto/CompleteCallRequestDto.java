package com.fathy.alfred.backend.calls.adapter.in.web.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;

/**
 * POST /calls/webhook/{id}/complete's body, plus the proxy's own wall-clock duration measurement
 * (see CallLifecycleStatus's doc). Usually exactly one of {@code response}/{@code error} is set -
 * but the proxy sends both when the upstream supplier answered yet the client that made the
 * original request had already disconnected (so the reply could never actually reach it): the
 * response is still captured in full for visibility, {@code error} records that delivery to the
 * client failed, and the call is still classified as {@link com.fathy.alfred.backend.calls.domain.model.CallLifecycleStatus#ERROR}
 * (see CallsService.receiveCompletedCall/SqliteCallsRepository.statusRank, which both treat a
 * non-blank error as taking priority over the response's own status).
 */
public record CompleteCallRequestDto(
        ResponseData response,
        String error,
        @JsonProperty("duration_ms") Double durationMs
) {
}
