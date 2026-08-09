package com.alfred.pennyworth.profiles.domain.model;

/**
 * Input to CreateProfileUseCase - already-validated fields for a profile that doesn't have an id
 * or createdAt yet (the application service assigns those, and fills in a random default avatar
 * when none is given). Kept distinct from the web layer's CreateProfileRequestDto because that
 * DTO also carries Bean Validation annotations, a transport concern that doesn't belong here.
 */
public record NewProfile(
        String name,
        String avatar
) {
}
