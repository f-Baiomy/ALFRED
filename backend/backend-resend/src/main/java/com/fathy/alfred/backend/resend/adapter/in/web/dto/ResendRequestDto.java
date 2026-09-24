package com.fathy.alfred.backend.resend.adapter.in.web.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/** POST /resend's body - see contracts/rest-api.md. */
public record ResendRequestDto(
        @NotBlank @Pattern(regexp = "outbound|inbound", message = "direction must be outbound or inbound")
        String direction,
        @NotBlank @Size(max = 200)
        String callId,
        @Size(max = 200)
        String cycleId,
        @Valid
        ResendEditsDto edits,
        boolean useCurrentSession) {
}
