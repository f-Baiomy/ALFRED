package com.fathy.alfred.backend.calls.adapter.in.web.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fathy.alfred.backend.calls.domain.model.RequestData;

/** POST /calls/webhook/prepare's body - request-side data only, sent the moment the proxy intercepts a call, before the upstream has responded. */
public record PrepareCallRequestDto(
        @JsonProperty("original_url") String originalUrl,
        String url,
        String method,
        RequestData request,
        String timestamp
) {
}
