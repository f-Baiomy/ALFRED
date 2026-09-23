package com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;

/** Web-layer input for POST /session-cycles/{id}/spacers. anchorTimestamp is the anchor call's own timestamp; both anchor fields null means "after every call" - see CycleSpacer. */
public record CreateCycleSpacerRequestDto(
        @NotBlank String label,
        String beforeCallId,
        String anchorTimestamp
) {
}
