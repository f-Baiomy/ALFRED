package com.alfred.pennyworth;

public record CommentRequestDto(
        String callId,
        String block,
        int lineIndex,
        String lineText,
        String comment
) {
}
