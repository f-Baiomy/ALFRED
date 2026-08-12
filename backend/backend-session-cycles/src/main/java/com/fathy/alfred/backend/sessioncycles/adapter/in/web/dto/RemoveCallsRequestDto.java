package com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto;

import jakarta.validation.constraints.NotEmpty;

import java.util.List;

/** Web-layer input for POST /session-cycles/{id}/calls/remove. */
public record RemoveCallsRequestDto(
        @NotEmpty List<String> callIds
) {
}
