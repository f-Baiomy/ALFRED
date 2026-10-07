package com.fathy.alfred.backend.server.application.port.in;

import com.fathy.alfred.backend.server.domain.model.EnvProblem;
import com.fathy.alfred.backend.server.domain.model.PendingRestart;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import com.fathy.alfred.backend.server.domain.model.SettingValue;

import java.util.List;

/** Every deploy-time setting with its effective value and where it came from (FR-010..012, FR-021, FR-054). */
public interface GetSettingsUseCase {

    record SettingsView(RuntimeMode mode, String envLocation, String envHash, List<SettingValue> settings,
                        List<String> missingFromEnv, List<EnvProblem> unknownLines, List<PendingRestart> pendingRestart) {
    }

    SettingsView settings();
}
