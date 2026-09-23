package com.fathy.alfred.backend.resend.adapter.in.web.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.Map;

public record ResendRequestDto(
        @NotBlank @Pattern(regexp = "outbound|inbound", message = "direction must be outbound or inbound") String direction,
        @NotBlank @Size(max = 200) String callId,
        @Size(max = 200) String cycleId,
        @Valid EditsDto edits,
        Boolean useCurrentSession) {

    public record EditsDto(
            @Size(max = 16) @Pattern(regexp = "[A-Za-z]+", message = "method must be letters only") String method,
            @Size(max = 8192, message = "url is at most 8 KB") String url,
            @Size(max = 100, message = "at most 100 header edits") Map<String, String> headers,
            String body) {
    }
}
