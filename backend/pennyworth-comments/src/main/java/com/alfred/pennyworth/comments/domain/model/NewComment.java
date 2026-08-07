package com.alfred.pennyworth.comments.domain.model;

/**
 * Input to CreateCommentUseCase - already-validated fields for a comment that doesn't have an id or
 * createdAt yet (the application service assigns those). Kept distinct from the web layer's
 * CommentRequestDto because that DTO also carries Bean Validation annotations, a transport concern
 * that doesn't belong on this domain command.
 */
public record NewComment(
        String callId,
        String block,
        int lineIndex,
        String lineText,
        String comment
) {
}
