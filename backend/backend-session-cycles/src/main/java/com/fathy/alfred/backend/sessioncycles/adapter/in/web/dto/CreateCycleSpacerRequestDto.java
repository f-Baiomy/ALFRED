package com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;

/** Web-layer input for POST /session-cycles/{id}/spacers. beforeCallId null means "after every call". */
public record CreateCycleSpacerRequestDto(
        @NotBlank String label,
        String beforeCallId
) {
}
