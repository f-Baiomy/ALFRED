package com.alfred.pennyworth.application.service;

import com.alfred.pennyworth.application.port.in.CreateCommentUseCase;
import com.alfred.pennyworth.application.port.in.DeleteCommentUseCase;
import com.alfred.pennyworth.application.port.in.ListCommentsUseCase;
import com.alfred.pennyworth.application.port.out.CommentsStorePort;
import com.alfred.pennyworth.domain.model.Comment;
import com.alfred.pennyworth.domain.model.NewComment;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
public class CommentsService implements ListCommentsUseCase, CreateCommentUseCase, DeleteCommentUseCase {

    private final CommentsStorePort store;

    public CommentsService(CommentsStorePort store) {
        this.store = store;
    }

    @Override
    public List<Comment> listByCallId(String callId) {
        return store.findAll().stream()
                .filter(c -> c.callId().equals(callId))
                .collect(Collectors.toList());
    }

    @Override
    public Comment create(NewComment newComment) {
        Comment comment = new Comment(
                UUID.randomUUID().toString(),
                newComment.callId(),
                newComment.block(),
                newComment.lineIndex(),
                newComment.lineText(),
                newComment.comment(),
                Instant.now().toString()
        );
        return store.save(comment);
    }

    @Override
    public boolean deleteById(String id) {
        return store.deleteById(id);
    }
}
