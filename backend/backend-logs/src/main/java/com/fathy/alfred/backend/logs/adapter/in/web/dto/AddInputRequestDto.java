package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import com.fathy.alfred.backend.logs.domain.model.InputKind;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/** {@code ref}: server path (SERVER_FILE / FOLLOW) or upload id (UPLOAD). */
public record AddInputRequestDto(@NotNull InputKind kind, @NotBlank @Size(max = 1024) String ref,
                                 @Size(max = 200) String fingerprint, boolean fromStart, boolean confirmDuplicate) {
}
