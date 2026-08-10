package com.fathy.alfred.backend.comments.application.port.in;

import com.fathy.alfred.backend.comments.domain.model.Comment;

import java.util.List;

public interface ListCommentsUseCase {

    List<Comment> listByCallId(String callId);
}
