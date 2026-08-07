package com.alfred.pennyworth.application.port.in;

import com.alfred.pennyworth.domain.model.Comment;

import java.util.List;

public interface ListCommentsUseCase {

    List<Comment> listByCallId(String callId);
}
