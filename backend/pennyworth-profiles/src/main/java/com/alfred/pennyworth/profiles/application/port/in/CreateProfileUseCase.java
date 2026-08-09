package com.alfred.pennyworth.profiles.application.port.in;

import com.alfred.pennyworth.profiles.domain.model.NewProfile;
import com.alfred.pennyworth.profiles.domain.model.Profile;

public interface CreateProfileUseCase {

    Profile create(NewProfile newProfile);
}
