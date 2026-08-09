package com.alfred.pennyworth.profiles.domain.model;

/** A named profile that session-cycles' assignedTo field can reference by id. avatar is a single emoji character. */
public record Profile(
        String id,
        String name,
        String createdAt,
        String avatar
) {
}
