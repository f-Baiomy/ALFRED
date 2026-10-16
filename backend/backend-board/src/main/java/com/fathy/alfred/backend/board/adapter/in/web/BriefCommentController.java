package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.BriefCommentsUseCase;
import com.fathy.alfred.backend.board.application.port.in.BriefCommentsUseCase.CommentOutcome;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/** Comments on a cycle's brief (specs/024, docs/board.md "Brief comments"). */
@RestController
public class BriefCommentController {

    private static final String ACTOR = BoardWeb.ACTOR_HEADER;

    /** A new comment or reply; asks and the suggestion are Claude's. */
    public record CommentRequest(String quote, String text, Long replyTo, Boolean asks, String suggestFrom, String suggestTo) {
    }

    private final BriefCommentsUseCase comments;

    public BriefCommentController(BriefCommentsUseCase comments) {
        this.comments = comments;
    }

    @GetMapping("/board/cycles/{cycleId}/brief/comments")
    public ResponseEntity<?> list(@PathVariable String cycleId) {
        return ResponseEntity.ok(comments.comments(cycleId));
    }

    @PostMapping("/board/cycles/{cycleId}/brief/comments")
    public ResponseEntity<?> add(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                 @RequestBody CommentRequest body) {
        if (body == null) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "A comment needs some text");
        }
        return answer(comments.add(BoardWeb.actor(actor), cycleId, new BriefCommentsUseCase.NewComment(body.quote(), body.text(),
                body.replyTo(), Boolean.TRUE.equals(body.asks()), body.suggestFrom(), body.suggestTo())));
    }

    @PostMapping("/board/cycles/{cycleId}/brief/comments/{id}/resolve")
    public ResponseEntity<?> resolve(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                     @PathVariable long id) {
        return answer(comments.resolve(BoardWeb.actor(actor), cycleId, id, true));
    }

    @PostMapping("/board/cycles/{cycleId}/brief/comments/{id}/reopen")
    public ResponseEntity<?> reopen(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                    @PathVariable long id) {
        return answer(comments.resolve(BoardWeb.actor(actor), cycleId, id, false));
    }

    @PostMapping("/board/cycles/{cycleId}/brief/comments/{id}/apply")
    public ResponseEntity<?> apply(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                   @PathVariable long id) {
        return answer(comments.apply(BoardWeb.actor(actor), cycleId, id));
    }

    @PostMapping("/board/cycles/{cycleId}/brief/comments/{id}/dismiss")
    public ResponseEntity<?> dismiss(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                     @PathVariable long id) {
        return answer(comments.dismiss(BoardWeb.actor(actor), cycleId, id));
    }

    private static ResponseEntity<?> answer(CommentOutcome out) {
        if (out.outcome() != CardChange.Outcome.OK) {
            return BoardWeb.refused(out.outcome(), out.message());
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("comment", out.comment());
        if (out.brief() != null) {
            body.put("brief", out.brief());
        }
        return ResponseEntity.ok(body);
    }
}
