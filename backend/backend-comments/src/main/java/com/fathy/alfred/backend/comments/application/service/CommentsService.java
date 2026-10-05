package com.fathy.alfred.backend.comments.application.service;

import com.fathy.alfred.backend.comments.application.port.in.CreateCommentUseCase;
import com.fathy.alfred.backend.comments.application.port.in.DeleteCommentUseCase;
import com.fathy.alfred.backend.comments.application.port.in.ListCommentsUseCase;
import com.fathy.alfred.backend.comments.application.port.out.CommentNotificationPort;
import com.fathy.alfred.backend.comments.application.port.out.CommentsStorePort;
import com.fathy.alfred.backend.comments.domain.model.Comment;
import com.fathy.alfred.backend.comments.domain.model.NewComment;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
public class CommentsService implements ListCommentsUseCase, CreateCommentUseCase, DeleteCommentUseCase {

    private final CommentsStorePort store;
    private final CommentNotificationPort notificationPort;

    public CommentsService(CommentsStorePort store, CommentNotificationPort notificationPort) {
        this.store = store;
        this.notificationPort = notificationPort;
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
        Comment saved = store.save(comment);
        notificationPort.notifyCommentsChanged(saved.callId());
        return saved;
    }

    @Override
    public boolean deleteById(String id) {
        // Looked up before the delete: once it is gone, nothing says which call's view to refresh.
        Optional<String> callId = store.findAll().stream().filter(c -> c.id().equals(id)).map(Comment::callId).findFirst();
        boolean deleted = store.deleteById(id);
        if (deleted) {
            callId.ifPresent(notificationPort::notifyCommentsChanged);
        }
        return deleted;
    }
}
