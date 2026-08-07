package com.alfred.pennyworth.comments.application.port.in;

import com.alfred.pennyworth.comments.domain.model.Comment;
import com.alfred.pennyworth.comments.domain.model.NewComment;

public interface CreateCommentUseCase {

    Comment create(NewComment newComment);
}
