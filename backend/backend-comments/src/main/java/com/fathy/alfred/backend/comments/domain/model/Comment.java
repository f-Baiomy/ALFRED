package com.fathy.alfred.backend.comments.domain.model;

/** A flagged issue on one line of a call's request/response, for the support-team export workflow. */
public record Comment(
        String id,
        String callId,
        String block,
        int lineIndex,
        String lineText,
        String comment,
        String createdAt
) {
}
