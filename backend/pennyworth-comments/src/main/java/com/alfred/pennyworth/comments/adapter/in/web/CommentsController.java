package com.alfred.pennyworth.comments.adapter.in.web;

import com.alfred.pennyworth.comments.adapter.in.web.dto.CommentRequestDto;
import com.alfred.pennyworth.comments.application.port.in.CreateCommentUseCase;
import com.alfred.pennyworth.comments.application.port.in.DeleteCommentUseCase;
import com.alfred.pennyworth.comments.application.port.in.ListCommentsUseCase;
import com.alfred.pennyworth.comments.domain.model.Comment;
import com.alfred.pennyworth.comments.domain.model.NewComment;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/comments")
public class CommentsController {

    private final ListCommentsUseCase listCommentsUseCase;
    private final CreateCommentUseCase createCommentUseCase;
    private final DeleteCommentUseCase deleteCommentUseCase;

    public CommentsController(
            ListCommentsUseCase listCommentsUseCase,
            CreateCommentUseCase createCommentUseCase,
            DeleteCommentUseCase deleteCommentUseCase
    ) {
        this.listCommentsUseCase = listCommentsUseCase;
        this.createCommentUseCase = createCommentUseCase;
        this.deleteCommentUseCase = deleteCommentUseCase;
    }

    @GetMapping
    public List<Comment> list(@RequestParam String callId) {
        return listCommentsUseCase.listByCallId(callId);
    }

    @PostMapping
    public Comment create(@Valid @RequestBody CommentRequestDto request) {
        NewComment newComment = new NewComment(
                request.callId(),
                request.block(),
                request.lineIndex(),
                request.lineText(),
                request.comment()
        );
        return createCommentUseCase.create(newComment);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        boolean deleted = deleteCommentUseCase.deleteById(id);
        return deleted ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}
