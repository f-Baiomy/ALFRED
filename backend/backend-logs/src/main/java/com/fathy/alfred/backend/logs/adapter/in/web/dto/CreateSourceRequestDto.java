package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.PrivacyMode;
import com.fathy.alfred.backend.logs.domain.model.RawMode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record CreateSourceRequestDto(@NotBlank @Size(max = 80) String name, @NotNull RawMode rawMode,
                                     @NotNull PrivacyMode privacyMode, @NotNull LogStructure structure) {
}
