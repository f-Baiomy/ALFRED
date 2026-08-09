package com.alfred.pennyworth.profiles.application.port.in;

import com.alfred.pennyworth.profiles.domain.model.Profile;
import com.alfred.pennyworth.profiles.domain.model.ProfileUpdate;

import java.util.Optional;

public interface UpdateProfileUseCase {

    Optional<Profile> update(String id, ProfileUpdate update);
}
