package com.fathy.alfred.backend.teamboards.core.adapter.in.web;

import com.fathy.alfred.backend.teamboards.core.application.port.in.SeedUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase.LinkResult;
import com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase.StartResult;
import com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase.Target;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
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
 * Start, the seed and the setup link (specs/027 US8, 028 FR-114). A start is the user's: as Claude
 * (X-Alfred-Actor: claude) it needs {@code askedIn}, the chat message or "terminal" where the user asked.
 */
@RestController
@Validated
public class TeamStartController {

    private final StartFromItemUseCase starts;
    private final SeedUseCase seeds;

    public TeamStartController(StartFromItemUseCase starts, SeedUseCase seeds) {
        this.starts = starts;
        this.seeds = seeds;
    }

    record TargetDto(@Size(max = 200) String project, @Size(max = 200) String boardId, boolean remember) {
    }

    record StartDto(@Valid TargetDto target, @Size(max = 40) String askedIn) {
    }

    record LinkDto(@NotBlank @Size(max = 100) String conn, @NotBlank @Size(max = 100) String extId, @Size(max = 40) String askedIn) {
    }

    @PostMapping("/teamboards/items/{conn}/{extId}/start")
    public ResponseEntity<?> start(@PathVariable String conn, @PathVariable String extId, @Valid @RequestBody(required = false) StartDto body,
                                   @RequestHeader(value = TeamboardsController.ACTOR_HEADER, required = false) String actor) {
        if (Who.of(actor) == Who.CLAUDE && (body == null || !starts.askedByUser(body.askedIn()))) {
            throw TeamException.userOnly("Only the user starts a board from a work item: askedIn must name the chat message (or \"terminal\") "
                    + "where the user asked");
        }
        Target target = body == null || body.target() == null ? null
                : new Target(body.target().project(), body.target().boardId(), body.target().remember());
        StartResult r = starts.start(conn, extId, target);
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
            case NOT_FOUND -> throw TeamException.notFound(r.message());
            case INVALID -> throw TeamException.invalid(r.message());
        };
    }

    @DeleteMapping("/teamboards/items/{conn}/{extId}/start")
    public ResponseEntity<?> cancel(@PathVariable String conn, @PathVariable String extId) {
        return switch (starts.cancel(conn, extId)) {
            case CANCELLED -> ResponseEntity.noContent().build();
            case NOT_WAITING -> throw TeamException.notFound("No start is waiting for this item");
            case TAKEN -> throw new TeamException(TeamException.Code.CONFLICT, "The setup has already begun - it finishes and opens the board");
        };
    }

    /** The start waiting for this item (204: none). */
    @GetMapping("/teamboards/items/{conn}/{extId}/start")
    public ResponseEntity<?> waiting(@PathVariable String conn, @PathVariable String extId) {
        return starts.waiting(conn, extId).<ResponseEntity<?>>map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    @GetMapping("/teamboards/items/{conn}/{extId}/target")
    public ResponseEntity<?> target(@PathVariable String conn, @PathVariable String extId) {
        Target t = starts.targetOf(conn, extId);
        return t == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(t);
    }

    @GetMapping("/teamboards/items/{conn}/{extId}/seed")
    public ResponseEntity<?> seed(@PathVariable String conn, @PathVariable String extId) {
        return seeds.seed(conn, extId).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseThrow(() -> TeamException.notFound("Item " + extId + " could not be read"));
    }

    /** /alfred-setup's link (team_link): the item becomes the board's main and the start's files move onto the board. */
    @PutMapping("/teamboards/links/{board}")
    public ResponseEntity<?> putLink(@PathVariable String board, @Valid @RequestBody LinkDto body,
                                     @RequestHeader(value = TeamboardsController.ACTOR_HEADER, required = false) String actor) {
        if (Who.of(actor) == Who.CLAUDE && !starts.isWaiting(body.conn(), body.extId()) && !starts.askedByUser(body.askedIn())) {
            throw TeamException.userOnly("No start waits for this item: link it only when the user asked (askedIn)");
        }
        LinkResult r = starts.link(Who.of(actor), board, body.conn(), body.extId());
        return ResponseEntity.ok(Map.of("attached", r.attached(), "notAttached", r.notAttached()));
    }

    @PostMapping("/teamboards/links/{board}/attachments/fetch")
    public ResponseEntity<?> fetchAttachments(@PathVariable String board) {
        LinkResult r = starts.fetchAttachments(board);
        return ResponseEntity.ok(Map.of("attached", r.attached(), "notAttached", r.notAttached()));
    }
}
