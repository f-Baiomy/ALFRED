package com.alfred.pennyworth.profiles.application.port.out;

import com.alfred.pennyworth.profiles.domain.model.Profile;

import java.util.List;
import java.util.Optional;

/** Outbound port: profile persistence, without the application core knowing it's a flat JSON file today. */
public interface ProfileStorePort {

    List<Profile> findAll();

    Optional<Profile> findById(String id);

    /** Upsert - saves a new profile or overwrites an existing one with the same id. */
    Profile save(Profile profile);

    /** @return true if a profile with this id existed and was deleted. */
    boolean deleteById(String id);
}
