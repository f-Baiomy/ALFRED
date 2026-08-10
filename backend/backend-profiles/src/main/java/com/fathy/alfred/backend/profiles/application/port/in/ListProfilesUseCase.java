package com.fathy.alfred.backend.profiles.application.port.in;

import com.fathy.alfred.backend.profiles.domain.model.Profile;

import java.util.List;

public interface ListProfilesUseCase {

    List<Profile> listAll();
}
