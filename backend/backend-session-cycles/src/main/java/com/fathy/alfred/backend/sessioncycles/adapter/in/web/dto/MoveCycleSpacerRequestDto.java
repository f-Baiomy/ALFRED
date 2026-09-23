package com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto;

/** Web-layer input for PATCH /session-cycles/{id}/spacers/{spacerId}/move. afterCallId is the call directly above the spacer's new position, anchorTimestamp that call's own timestamp; both null means "above every call" - see CycleSpacer. */
public record MoveCycleSpacerRequestDto(
        String afterCallId,
        String anchorTimestamp
) {
}
