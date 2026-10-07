package com.fathy.alfred.backend.server.application.service;

import com.fathy.alfred.backend.server.domain.model.ValidationResult;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Checks that need the machine (a port in use, a folder that does not exist, free disk) - run on every save and on
 * demand by the check endpoint. Their results join SettingsValidator's: ERROR blocks a save, WARNING does not.
 */
public class SettingsProbes {

    public static SettingsProbes none() {
        return new SettingsProbes();
    }

    protected SettingsProbes() {
    }

    /** Results for {@code keys}, judged against the settings as they would be after the save. */
    public List<ValidationResult> check(Map<String, String> effective, Set<String> keys) {
        return List.of();
    }
}
