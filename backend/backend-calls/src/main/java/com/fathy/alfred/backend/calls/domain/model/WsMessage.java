package com.fathy.alfred.backend.calls.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * One WebSocket message logged after interception ran - see docs/interception.md and
 * data-model.md §8. {@code type} is {@code text} or {@code binary}; a binary message's content
 * rides in {@code contentBase64} instead of {@code content}. {@code action} is null (passed
 * through unchanged), {@code edited}, {@code dropped}, or {@code delayed:<ms>}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record WsMessage(int seq, String direction, long tsMillis, String type, String content,
                         String contentBase64, String originalContent, String action) {
}
