package com.alfred.pennyworth.sessioncycles.adapter.in.web.dto;

/** Web-layer input for PATCH /session-cycles/{id} - a null field means "leave this alone", not "clear it". */
public record UpdateSessionCycleRequestDto(
        String name,
        String assignedTo
) {
}
