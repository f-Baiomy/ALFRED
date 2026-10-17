package com.fathy.alfred.backend.teamboards.core.adapter.in.web;

import com.fathy.alfred.backend.teamboards.core.application.port.in.LinksUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.LinksUseCase.LinkResult;
import com.fathy.alfred.backend.teamboards.core.application.port.in.SeedUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase.StartResult;
import com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase.Target;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Start, the seed and board links (specs/027 contracts/teamboards-rest.md, US8/US9). A start is the user's: a call as
 * Claude (X-Alfred-Actor: claude) needs {@code askedIn}, the chat message or "terminal" where the user asked.
 */
@RestController
@Validated
public class TeamStartController {

    private final StartFromItemUseCase starts;
    private final LinksUseCase links;
    private final SeedUseCase seeds;

    public TeamStartController(StartFromItemUseCase starts, LinksUseCase links, SeedUseCase seeds) {
        this.starts = starts;
        this.links = links;
        this.seeds = seeds;
    }

    record TargetDto(@Size(max = 200) String project, @Size(max = 200) String boardId, boolean remember) {
    }

    record StartDto(@Valid TargetDto target, @Size(max = 40) String askedIn) {
    }

    record LinkDto(@NotBlank @Size(max = 100) String conn, @NotBlank @Size(max = 100) String extId, @Size(max = 40) String askedIn) {
    }

    private static Token token(String header) {
        return header == null || header.isBlank() ? null : new Token(header.strip());
    }

    private static ResponseEntity<?> error(HttpStatus status, String code, String message) {
        return TeamboardsController.error(status, code, message);
    }

    @PostMapping("/teamboards/items/{conn}/{extId}/start")
    public ResponseEntity<?> start(@PathVariable String conn, @PathVariable String extId, @Valid @RequestBody(required = false) StartDto body,
                                   @RequestHeader(value = TeamboardsController.TOKEN_HEADER, required = false) String token,
                                   @RequestHeader(value = "X-Alfred-Actor", required = false) String actor) {
        if ("claude".equalsIgnoreCase(actor) && (body == null || !starts.askedByUser(body.askedIn()))) {
            return error(HttpStatus.FORBIDDEN, "USER_ONLY",
                    "Only the user starts a board from a work item: askedIn must name the chat message (or \"terminal\") where the user asked");
        }
        Target target = body == null || body.target() == null ? null
                : new Target(body.target().project(), body.target().boardId(), body.target().remember());
        StartResult r = starts.start(conn, extId, target, token(token));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("state", r.outcome().name());
        out.put("project", r.project());
        out.put("boardId", r.boardId());
        out.put("messageId", r.messageId());
        out.put("attachmentsFetched", r.attachmentsFetched());
        out.put("answeredBy", r.answeredBy());
        out.put("message", r.message());
        return switch (r.outcome()) {
            case WAITING -> ResponseEntity.status(HttpStatus.ACCEPTED).body(out);
            case NEEDS_TARGET, ALREADY_STARTED -> {
                out.put("error", r.outcome().name());
                yield ResponseEntity.status(HttpStatus.CONFLICT).body(out);
            }
            case NOT_FOUND -> error(HttpStatus.NOT_FOUND, "NOT_FOUND", r.message());
            case INVALID -> error(HttpStatus.BAD_REQUEST, "INVALID", r.message());
        };
    }

    @DeleteMapping("/teamboards/items/{conn}/{extId}/start")
    public ResponseEntity<?> cancel(@PathVariable String conn, @PathVariable String extId) {
        return switch (starts.cancel(conn, extId)) {
            case CANCELLED -> ResponseEntity.noContent().build();
            case NOT_WAITING -> error(HttpStatus.NOT_FOUND, "NOT_FOUND", "No start is waiting for this item");
            case TAKEN -> error(HttpStatus.CONFLICT, "TAKEN", "The setup has already begun - it finishes and opens the board");
        };
    }

    @GetMapping("/teamboards/items/{conn}/{extId}/target")
    public ResponseEntity<?> target(@PathVariable String conn, @PathVariable String extId) {
        Target t = starts.targetOf(conn, extId);
        return t == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(t);
    }

    @GetMapping("/teamboards/items/{conn}/{extId}/seed")
    public ResponseEntity<?> seed(@PathVariable String conn, @PathVariable String extId) {
        return seeds.seed(conn, extId).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> error(HttpStatus.NOT_FOUND, "NOT_FOUND", "Item " + extId + " is not in the cache yet: Refresh the Team tab first"));
    }

    // --------------------------------------------------------------------------------------------------------- links

    @GetMapping("/teamboards/links/{board}")
    public ResponseEntity<?> link(@PathVariable String board) {
        return links.linkOf(board).<ResponseEntity<?>>map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    @PutMapping("/teamboards/links/{board}")
    public ResponseEntity<?> putLink(@PathVariable String board, @Valid @RequestBody LinkDto body,
                                     @RequestHeader(value = "X-Alfred-Actor", required = false) String actor) {
        // Claude links only the board it set up for a waiting start, or one the user asked for
        if ("claude".equalsIgnoreCase(actor) && !starts.isWaiting(body.conn(), body.extId()) && !starts.askedByUser(body.askedIn())) {
            return error(HttpStatus.FORBIDDEN, "USER_ONLY", "No start waits for this item: link it only when the user asked (askedIn)");
        }
        return linkResult(links.link(board, body.conn(), body.extId()));
    }

    @DeleteMapping("/teamboards/links/{board}")
    public ResponseEntity<?> unlink(@PathVariable String board) {
        return links.unlink(board) ? ResponseEntity.noContent().build() : error(HttpStatus.NOT_FOUND, "NOT_FOUND", "Board " + board + " has no link");
    }

    @PostMapping("/teamboards/links/{board}/seen")
    public ResponseEntity<?> seen(@PathVariable String board) {
        return links.seen(board) ? ResponseEntity.noContent().build() : error(HttpStatus.NOT_FOUND, "NOT_FOUND", "Board " + board + " has no link");
    }

    @PostMapping("/teamboards/links/{board}/attachments/fetch")
    public ResponseEntity<?> fetchAttachments(@PathVariable String board,
                                              @RequestHeader(value = TeamboardsController.TOKEN_HEADER, required = false) String token) {
        return linkResult(links.fetchAttachments(board, token(token)));
    }

    private static ResponseEntity<?> linkResult(LinkResult r) {
        return switch (r.outcome()) {
            case OK -> ResponseEntity.ok(Map.of("attached", r.attached(), "notAttached", r.notAttached()));
            case NOT_FOUND -> error(HttpStatus.NOT_FOUND, "NOT_FOUND", r.message());
            case ALREADY_LINKED -> error(HttpStatus.CONFLICT, "ALREADY_LINKED", r.message());
            case INVALID -> error(HttpStatus.BAD_REQUEST, "INVALID", r.message());
            case TOKEN_MISSING -> error(HttpStatus.UNAUTHORIZED, "TOKEN_MISSING", r.message());
            case TOKEN_REJECTED -> error(HttpStatus.FORBIDDEN, "TOKEN_REJECTED", r.message());
            case UNREACHABLE -> error(HttpStatus.BAD_GATEWAY, "UNREACHABLE", r.message());
        };
    }
}
