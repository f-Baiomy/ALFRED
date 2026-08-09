package com.alfred.pennyworth.profiles.application.port.in;

import com.alfred.pennyworth.profiles.domain.model.Profile;

import java.util.List;

public interface ListProfilesUseCase {

    List<Profile> listAll();
}
