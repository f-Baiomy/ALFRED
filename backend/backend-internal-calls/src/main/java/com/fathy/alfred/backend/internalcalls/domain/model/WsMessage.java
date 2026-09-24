package com.fathy.alfred.backend.internalcalls.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/** Mirrors backend-calls' own WsMessage record exactly (same wire shape) - see data-model.md §8. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record WsMessage(int seq, String direction, long tsMillis, String type, String content,
                         String contentBase64, String originalContent, String action) {
}
