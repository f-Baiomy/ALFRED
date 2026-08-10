package com.fathy.alfred.backend.profiles.application.port.in;

import com.fathy.alfred.backend.profiles.domain.model.Profile;

import java.util.Optional;

public interface GetProfileUseCase {

    Optional<Profile> getById(String id);
}
