package com.fathy.alfred.backend.resend.adapter.in.web.dto;

import jakarta.validation.constraints.Size;

import java.util.Map;

/**
 * What to change before resending - per contracts/rest-api.md. A header whose value is
 * {@code null} means remove that header. {@code url}'s length limit is Bean Validation; the
 * header-count/value-length and body-byte-length limits are checked in ResendController, since
 * Bean Validation has no clean way to size-limit a Map's individual values.
 */
public record ResendEditsDto(
        String method,
        @Size(max = 8192, message = "url must be 8192 characters or fewer")
        String url,
        Map<String, String> headers,
        String body) {
}
