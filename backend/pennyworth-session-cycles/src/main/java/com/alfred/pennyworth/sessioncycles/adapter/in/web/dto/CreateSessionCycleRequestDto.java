package com.alfred.pennyworth.sessioncycles.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;

/** Web-layer input for POST /session-cycles. assignedTo is optional - profiles don't exist yet, so it's an unvalidated free string. */
public record CreateSessionCycleRequestDto(
        @NotBlank String name,
        String assignedTo
) {
}
