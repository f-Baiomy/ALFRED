package com.fathy.alfred.backend.resend.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record ReliveResendTargetDto(@NotBlank @Size(max = 200) String runId, @NotBlank @Size(max = 200) String stepKey) {
}
