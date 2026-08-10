package com.fathy.alfred.backend.profiles.application.port.in;

import com.fathy.alfred.backend.profiles.domain.model.NewProfile;
import com.fathy.alfred.backend.profiles.domain.model.Profile;

public interface CreateProfileUseCase {

    Profile create(NewProfile newProfile);
}
