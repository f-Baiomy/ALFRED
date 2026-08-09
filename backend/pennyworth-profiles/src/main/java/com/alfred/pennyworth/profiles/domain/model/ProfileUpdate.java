package com.alfred.pennyworth.profiles.domain.model;

/** Input to UpdateProfileUseCase - a null field means "leave this alone", not "clear it". */
public record ProfileUpdate(
        String name,
        String avatar
) {
}
