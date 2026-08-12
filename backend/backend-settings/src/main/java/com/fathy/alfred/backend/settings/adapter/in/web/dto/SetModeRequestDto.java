package com.fathy.alfred.backend.settings.adapter.in.web.dto;

import com.fathy.alfred.backend.settings.domain.model.FilterMode;
import jakarta.validation.constraints.NotNull;

public record SetModeRequestDto(@NotNull FilterMode mode) {
}
