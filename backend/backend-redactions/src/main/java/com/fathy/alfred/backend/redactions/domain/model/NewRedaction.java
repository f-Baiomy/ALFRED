package com.fathy.alfred.backend.redactions.domain.model;

/**
 * Input to CreateRedactionUseCase - already-validated fields for a redaction that doesn't have an
 * id or createdAt yet (the application service assigns those). Kept distinct from the web layer's
 * RedactionRequestDto because that DTO also carries Bean Validation annotations, a transport
 * concern that doesn't belong on this domain command.
 *
 * <p>Like {@link Redaction}, this carries only the NAME of the thing to mask - never the secret
 * value found under that name. See Redaction's javadoc for why that is non-negotiable.
 */
public record NewRedaction(
        RedactionScope scope,
        String callId,
        RedactionKind kind,
        String name
) {
}
