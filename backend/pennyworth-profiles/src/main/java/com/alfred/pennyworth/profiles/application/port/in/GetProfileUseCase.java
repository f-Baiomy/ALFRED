package com.alfred.pennyworth.profiles.application.port.in;

import com.alfred.pennyworth.profiles.domain.model.Profile;

import java.util.Optional;

public interface GetProfileUseCase {

    Optional<Profile> getById(String id);
}
