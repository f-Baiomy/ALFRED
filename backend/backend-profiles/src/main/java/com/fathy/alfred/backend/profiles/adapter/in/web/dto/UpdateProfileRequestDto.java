package com.fathy.alfred.backend.profiles.adapter.in.web.dto;

/** Web-layer input for PATCH /profiles/{id} - a null field means "leave this alone", not "clear it". */
public record UpdateProfileRequestDto(
        String name,
        String avatar
) {
}
