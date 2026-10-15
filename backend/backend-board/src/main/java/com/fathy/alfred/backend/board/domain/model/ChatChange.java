package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * A chat message for Claude to take, as {@code board_changes} / {@code board_wait} hand it over (specs/022 research R2):
 * a user's message waiting for an answer, or a task (compact, explain more, watch on/off). Handled in time order with
 * card entries, urgent ones first. {@code seq} is its place in the waiting order - a message put back to waiting (its
 * runner went away) gets a new one, so a reader past its first listing still sees it again.
 */
public record ChatChange(long messageId, String project, String scope, ChatMessage.Kind kind, boolean urgent, Long parentId,
                         String origin, String text, Instant at, long seq) {
}
