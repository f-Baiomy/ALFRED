package com.fathy.alfred.backend.profiles.domain.model;

/** Input to UpdateProfileUseCase - a null field means "leave this alone", not "clear it". */
public record ProfileUpdate(
        String name,
        String avatar
) {
}
