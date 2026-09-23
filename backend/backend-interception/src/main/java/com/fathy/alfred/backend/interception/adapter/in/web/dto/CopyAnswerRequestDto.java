package com.fathy.alfred.backend.interception.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Which logged call to copy a response from.
 *
 * @param keepSecrets absent until the user has answered the keep/strip question; the first
 *                    request for a response with secret headers is answered 409 with their names.
 */
public record CopyAnswerRequestDto(
        @NotBlank @Pattern(regexp = "outbound|inbound", message = "direction must be outbound or inbound")
        String direction,
        @NotBlank @Size(max = 200)
        String callId,
        @Size(max = 200)
        String cycleId,
        Boolean keepSecrets) {
}
