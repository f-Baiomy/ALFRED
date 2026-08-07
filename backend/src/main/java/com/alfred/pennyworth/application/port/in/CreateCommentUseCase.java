package com.alfred.pennyworth.application.port.in;

import com.alfred.pennyworth.domain.model.Comment;
import com.alfred.pennyworth.domain.model.NewComment;

public interface CreateCommentUseCase {

    Comment create(NewComment newComment);
}
