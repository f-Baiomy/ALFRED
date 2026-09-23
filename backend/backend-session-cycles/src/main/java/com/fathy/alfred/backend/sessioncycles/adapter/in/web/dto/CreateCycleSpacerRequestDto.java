package com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;

/** Web-layer input for POST /session-cycles/{id}/spacers. afterCallId is the call directly above the new spacer, anchorTimestamp that call's own timestamp; both null means "above every call" - see CycleSpacer. */
public record CreateCycleSpacerRequestDto(
        @NotBlank String label,
        String afterCallId,
        String anchorTimestamp
) {
}
