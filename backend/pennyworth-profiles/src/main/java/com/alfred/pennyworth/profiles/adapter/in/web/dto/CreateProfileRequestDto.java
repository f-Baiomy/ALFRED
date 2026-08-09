package com.alfred.pennyworth.profiles.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * Web-layer input for POST /profiles. Carries Bean Validation annotations - a transport concern -
 * which is exactly why this is a distinct type from the domain's NewProfile rather than reusing
 * it directly (see the DTO-vs-domain-reuse rule in CLAUDE.md). avatar is optional - a blank/absent
 * value lets the service assign a random default.
 */
public record CreateProfileRequestDto(
        @NotBlank String name,
        String avatar
) {
}
