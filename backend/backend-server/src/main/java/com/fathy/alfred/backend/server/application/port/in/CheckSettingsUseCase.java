package com.fathy.alfred.backend.server.application.port.in;

import com.fathy.alfred.backend.server.domain.model.SettingsChange;
import com.fathy.alfred.backend.server.domain.model.ValidationResult;

import java.util.List;

/**
 * Checks values as they are typed, or every current value ("Check everything", FR-033): format rules and the machine
 * probes. Writes nothing; at most 5 s per request.
 */
public interface CheckSettingsUseCase {

    List<ValidationResult> check(List<SettingsChange.Edit> edits, boolean all);
}
