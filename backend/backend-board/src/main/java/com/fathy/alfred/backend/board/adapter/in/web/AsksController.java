package com.fathy.alfred.backend.board.adapter.in.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.board.application.port.in.AsksUseCase;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** Ask Claude from a snippet or the editor (specs/017 R24, R38). Under /board: the board's edit access applies. */
@RestController
public class AsksController {

    /** {@code data}: any JSON the asker attaches. */
    public record AskRequest(String project, String cycleId, String cardId, String snippetId, String kind, String question, JsonNode data) {
    }

    public record AnswerRequest(String text) {
    }

    private final AsksUseCase asks;

    public AsksController(AsksUseCase asks) {
        this.asks = asks;
    }

    @PostMapping("/board/asks")
    public ResponseEntity<?> ask(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @RequestBody AskRequest body) {
        String data = body.data() == null || body.data().isNull() ? null : body.data().toString();
        return respond(asks.ask(BoardWeb.actor(actor), new AsksUseCase.NewAsk(body.project(), body.cycleId(), body.cardId(), body.snippetId(),
                body.kind(), body.question(), data)), HttpStatus.CREATED);
    }

    @GetMapping("/board/asks/{id}")
    public ResponseEntity<?> get(@PathVariable String id) {
        return asks.get(id).<ResponseEntity<?>>map(ResponseEntity::ok).orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such ask"));
    }

    @PutMapping("/board/asks/{id}/answer")
    public ResponseEntity<?> answer(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                    @RequestBody AnswerRequest body) {
        return respond(asks.answer(BoardWeb.actor(actor), id, body.text()), HttpStatus.OK);
    }

    @PostMapping("/board/asks/{id}/cancel")
    public ResponseEntity<?> cancel(@PathVariable String id) {
        return respond(asks.cancel(id), HttpStatus.OK);
    }

    private static ResponseEntity<?> respond(AsksUseCase.Sent sent, HttpStatus ok) {
        if (sent.error() == null) {
            return ResponseEntity.status(ok).body(sent.ask());
        }
        CardChange.Outcome outcome = switch (sent.error()) {
            case "not-found" -> CardChange.Outcome.NOT_FOUND;
            case "conflict" -> CardChange.Outcome.CONFLICT;
            default -> CardChange.Outcome.INVALID;
        };
        return BoardWeb.refused(outcome, sent.message());
    }
}
