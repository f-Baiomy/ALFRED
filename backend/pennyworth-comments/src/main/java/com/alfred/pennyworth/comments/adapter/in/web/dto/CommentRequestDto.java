package com.alfred.pennyworth.comments.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.PositiveOrZero;

/**
 * Web-layer input for POST /comments. Carries Bean Validation annotations - a transport concern -
 * which is exactly why this is a distinct type from the domain's NewComment rather than reusing it
 * directly (see the DTO-vs-domain-reuse rule in CLAUDE.md).
 */
public record CommentRequestDto(
        @NotBlank String callId,
        @NotBlank String block,
        @PositiveOrZero int lineIndex,
        String lineText,
        @NotBlank String comment
) {
}
