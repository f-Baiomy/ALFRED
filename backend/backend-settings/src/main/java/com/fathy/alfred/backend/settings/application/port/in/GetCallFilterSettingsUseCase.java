package com.fathy.alfred.backend.settings.application.port.in;

import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;

public interface GetCallFilterSettingsUseCase {

    CallFilterSettings getSettings();
}
