package com.fathy.alfred.backend.comments.application.port.in;

import com.fathy.alfred.backend.comments.domain.model.Comment;
import com.fathy.alfred.backend.comments.domain.model.NewComment;

public interface CreateCommentUseCase {

    Comment create(NewComment newComment);
}
