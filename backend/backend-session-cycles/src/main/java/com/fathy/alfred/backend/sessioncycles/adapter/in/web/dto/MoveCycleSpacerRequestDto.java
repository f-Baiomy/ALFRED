package com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto;

/** Web-layer input for PATCH /session-cycles/{id}/spacers/{spacerId}/move. beforeCallId null means "after every call". */
public record MoveCycleSpacerRequestDto(
        String beforeCallId
) {
}
