package com.fathy.alfred.backend.comments.adapter.in.web;

import com.fathy.alfred.backend.comments.adapter.in.web.dto.CommentRequestDto;
import com.fathy.alfred.backend.comments.application.port.in.CountCommentsUseCase;
import com.fathy.alfred.backend.comments.application.port.in.CreateCommentUseCase;
import com.fathy.alfred.backend.comments.application.port.in.DeleteCommentUseCase;
import com.fathy.alfred.backend.comments.application.port.in.ListCommentsUseCase;
import com.fathy.alfred.backend.comments.domain.model.Comment;
import com.fathy.alfred.backend.comments.domain.model.CommentCount;
import com.fathy.alfred.backend.comments.domain.model.NewComment;
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

import java.util.Arrays;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/comments")
public class CommentsController {

    /** Ids per counts request - the frontend batches a screen into chunks of this size. */
    static final int MAX_COUNT_IDS = 500;

    private final ListCommentsUseCase listCommentsUseCase;
    private final CountCommentsUseCase countCommentsUseCase;
    private final CreateCommentUseCase createCommentUseCase;
    private final DeleteCommentUseCase deleteCommentUseCase;

    public CommentsController(
            ListCommentsUseCase listCommentsUseCase,
            CountCommentsUseCase countCommentsUseCase,
            CreateCommentUseCase createCommentUseCase,
            DeleteCommentUseCase deleteCommentUseCase
    ) {
        this.listCommentsUseCase = listCommentsUseCase;
        this.countCommentsUseCase = countCommentsUseCase;
        this.createCommentUseCase = createCommentUseCase;
        this.deleteCommentUseCase = deleteCommentUseCase;
    }

    @GetMapping
    public List<Comment> list(@RequestParam String callId) {
        return listCommentsUseCase.listByCallId(callId);
    }

    /** {@code ?callIds=a,b,c} → counts for the ones with comments. More than MAX_COUNT_IDS ids is a 400, not a slow request. */
    @GetMapping("/counts")
    public ResponseEntity<Map<String, CommentCount>> counts(@RequestParam(defaultValue = "") String callIds) {
        List<String> ids = Arrays.stream(callIds.split(",")).map(String::trim).filter(id -> !id.isEmpty()).distinct().toList();
        if (ids.size() > MAX_COUNT_IDS) {
            return ResponseEntity.badRequest().build();
        }
        return ResponseEntity.ok(countCommentsUseCase.countByCallIds(ids));
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
