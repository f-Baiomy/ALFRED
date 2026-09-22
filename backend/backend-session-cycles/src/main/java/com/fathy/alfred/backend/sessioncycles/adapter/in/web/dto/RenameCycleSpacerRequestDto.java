package com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;

/** Web-layer input for PATCH /session-cycles/{id}/spacers/{spacerId}. */
public record RenameCycleSpacerRequestDto(
        @NotBlank String label
) {
}
