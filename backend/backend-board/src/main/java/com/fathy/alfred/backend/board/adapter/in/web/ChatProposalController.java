package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.ChatProposalUseCase;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Result;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * Proposals and consents in a chat answer (specs/022 FR-026, FR-028, FR-046). Writes go through
 * BoardEditAccessInterceptor like the rest of /board: the tunnel never accepts a proposal.
 */
@RestController
public class ChatProposalController {

    private final ChatProposalUseCase proposals;

    public ChatProposalController(ChatProposalUseCase proposals) {
        this.proposals = proposals;
    }

    private static <T> ResponseEntity<?> respond(Result<T> r) {
        return r.isOk() ? ResponseEntity.ok(r.value() == null ? Map.of() : r.value()) : BoardWeb.refused(r.outcome(), r.message());
    }

    public record DecideDto(@Size(max = 50) List<@Size(max = 200) String> accept, @Size(max = 50) List<@Size(max = 200) String> decline) {
    }

    @PostMapping("/board/chats/messages/{id}/proposals")
    public ResponseEntity<?> decide(@PathVariable long id, @Valid @RequestBody DecideDto body,
                                    @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(proposals.decide(BoardWeb.actor(actor), id, body.accept(), body.decline()));
    }

    /** Each open proposal checked against the board now (FR-026: re-checked when shown). */
    @GetMapping("/board/chats/messages/{id}/proposals")
    public ResponseEntity<?> check(@PathVariable long id) {
        Result<Map<String, String>> r = proposals.check(id);
        return r.isOk() ? ResponseEntity.ok(Map.of("checks", r.value())) : BoardWeb.refused(r.outcome(), r.message());
    }

    @PostMapping("/board/chats/undo/{token}")
    public ResponseEntity<?> undo(@PathVariable String token, @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(proposals.undo(BoardWeb.actor(actor), token));
    }

    /** One applied proposal put back, at any time - while the board is still as it left it. */
    @PostMapping("/board/chats/messages/{id}/proposals/{proposalId}/undo")
    public ResponseEntity<?> undoOne(@PathVariable long id, @PathVariable String proposalId,
                                     @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(proposals.undoOne(BoardWeb.actor(actor), id, proposalId));
    }

    public record ConsentDto(boolean yes) {
    }

    @PostMapping("/board/chats/messages/{id}/consent")
    public ResponseEntity<?> consent(@PathVariable long id, @RequestBody ConsentDto body,
                                     @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(proposals.consent(BoardWeb.actor(actor), id, body.yes()));
    }
}
