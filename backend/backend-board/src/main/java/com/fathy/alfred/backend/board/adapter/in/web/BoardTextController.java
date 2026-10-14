package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.BoardImagesUseCase;
import com.fathy.alfred.backend.board.application.port.in.CommentExtrasUseCase;
import com.fathy.alfred.backend.board.domain.model.BoardImage;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.Map;

/**
 * Rich text on the board (docs/board.md "Rich text"): reactions on comments, the user editing their own comment, the
 * earlier texts of a comment or description, and the pictures pasted into texts. Writes go through the board's edit rule
 * (BoardEditAccessInterceptor), so the tunnel only reads.
 */
@RestController
public class BoardTextController {

    private static final String ACTOR = "X-Alfred-Actor";

    private final CommentExtrasUseCase comments;
    private final BoardImagesUseCase images;

    public BoardTextController(CommentExtrasUseCase comments, BoardImagesUseCase images) {
        this.comments = comments;
        this.images = images;
    }

    @PostMapping("/board/cards/{id}/comments/{entryId}/reactions")
    public ResponseEntity<?> react(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id, @PathVariable long entryId,
                                   @Valid @RequestBody ReactionDto body) {
        CommentExtrasUseCase.Outcome out = comments.react(BoardWeb.actor(actor), id, entryId, body.emoji());
        return out.outcome() == CardChange.Outcome.OK ? ResponseEntity.ok(Map.of("on", out.on())) : BoardWeb.refused(out.outcome(), out.message());
    }

    @PutMapping("/board/cards/{id}/comments/{entryId}")
    public ResponseEntity<?> edit(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id, @PathVariable long entryId,
                                  @Valid @RequestBody EditDto body) {
        CommentExtrasUseCase.Outcome out = comments.editComment(BoardWeb.actor(actor), id, entryId, body.text());
        return out.outcome() == CardChange.Outcome.OK ? ResponseEntity.ok(Map.of("changed", out.on())) : BoardWeb.refused(out.outcome(), out.message());
    }

    @GetMapping("/board/versions")
    public ResponseEntity<?> versions(@RequestParam String owner) {
        return ResponseEntity.ok(comments.versions(owner));
    }

    /** The picture's bytes as the body, its type as Content-Type (PNG, JPEG, GIF, WebP; at most 5 MB). */
    @PostMapping(value = "/board/images", consumes = {"image/png", "image/jpeg", "image/gif", "image/webp"})
    public ResponseEntity<?> upload(@RequestHeader(HttpHeaders.CONTENT_TYPE) String type, @RequestBody byte[] data) {
        BoardImagesUseCase.Saved saved = images.save(type, data);
        if (saved.id() == null) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, saved.error());
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("id", saved.id(), "url", "/board/images/" + saved.id()));
    }

    @GetMapping("/board/images/{id}")
    public ResponseEntity<byte[]> image(@PathVariable String id) {
        return images.image(id).map(BoardTextController::picture).orElseGet(() -> ResponseEntity.notFound().build());
    }

    private static ResponseEntity<byte[]> picture(BoardImage i) {
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(i.mime()))
                .cacheControl(CacheControl.maxAge(Duration.ofDays(365)).cachePrivate().immutable())
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Security-Policy", "default-src 'none'")
                .body(i.data());
    }

    public record ReactionDto(@Size(max = 16) String emoji) {
    }

    public record EditDto(@Size(max = 512 * 1024) String text) {
    }
}
