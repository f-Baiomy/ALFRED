package com.fathy.alfred.backend.redactions.adapter.in.web.dto;

import com.fathy.alfred.backend.redactions.domain.model.RedactionKind;
import com.fathy.alfred.backend.redactions.domain.model.RedactionScope;
import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

/**
 * Web-layer input for POST /redactions. Carries Bean Validation annotations - a transport concern -
 * which is exactly why this is a distinct type from the domain's NewRedaction rather than reusing
 * it directly (see the DTO-vs-domain-reuse rule in CLAUDE.md).
 *
 * <p>There is deliberately no field for the secret's VALUE, only {@code name}. See
 * {@code Redaction}'s javadoc.
 */
public record RedactionRequestDto(
        @NotNull RedactionScope scope,
        String callId,
        @NotNull RedactionKind kind,
        @NotBlank String name
) {

    /**
     * Cross-field rule as a Bean Validation constraint rather than a hand-thrown exception, so a
     * bad scope/callId combination comes back as the same 400 + {"error": "..."} body that any
     * other invalid field does (GlobalExceptionHandler only maps MethodArgumentNotValidException).
     */
    @JsonIgnore
    @AssertTrue(message = "CALL scope requires a callId, ALL scope requires no callId")
    public boolean isCallIdConsistentWithScope() {
        if (scope == null) {
            return true; // @NotNull already reports this one; don't double-report it here.
        }
        boolean hasCallId = callId != null && !callId.isBlank();
        return scope == RedactionScope.CALL ? hasCallId : !hasCallId;
    }
}
