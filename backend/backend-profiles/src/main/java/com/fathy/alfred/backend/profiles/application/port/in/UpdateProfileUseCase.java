package com.fathy.alfred.backend.profiles.application.port.in;

import com.fathy.alfred.backend.profiles.domain.model.Profile;
import com.fathy.alfred.backend.profiles.domain.model.ProfileUpdate;

import java.util.Optional;

public interface UpdateProfileUseCase {

    Optional<Profile> update(String id, ProfileUpdate update);
}
