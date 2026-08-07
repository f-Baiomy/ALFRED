package com.alfred.pennyworth.comments.application.port.in;

import com.alfred.pennyworth.comments.domain.model.Comment;

import java.util.List;

public interface ListCommentsUseCase {

    List<Comment> listByCallId(String callId);
}
