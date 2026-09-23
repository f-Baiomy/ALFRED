package com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto;

/** Web-layer input for PATCH /session-cycles/{id}/spacers/{spacerId}/move. anchorTimestamp is the anchor call's own timestamp; both null means "after every call" - see CycleSpacer. */
public record MoveCycleSpacerRequestDto(
        String beforeCallId,
        String anchorTimestamp
) {
}
