package com.fathy.alfred.backend.settings.application.port.in;

import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;
import com.fathy.alfred.backend.settings.domain.model.FilterMode;

public interface SetFilterModeUseCase {

    CallFilterSettings setMode(FilterMode mode);
}
