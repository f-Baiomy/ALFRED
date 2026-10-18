package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.BoardCyclesUseCase;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * The board's Cycles tab (specs/033): {@code GET /board/boards/{id}/cycle-rows} - its cycles with kind, ⚑ baseline,
 * archived and the cards each re-test tests; {@code GET /board/cards/{id}/cycle-verdicts} - a card's verdict in every
 * cycle that checked it; {@code PUT /board/boards/{id}/cycles/{cycleId}/flags} - the user's baseline / archive.
 */
@RestController
public class BoardCyclesController {

    private final BoardCyclesUseCase cycles;

    public BoardCyclesController(BoardCyclesUseCase cycles) {
        this.cycles = cycles;
    }

    @GetMapping("/board/boards/{id}/cycle-rows")
    public ResponseEntity<?> rows(@PathVariable String id) {
        return cycles.cycles(id).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such board"));
    }

    @GetMapping("/board/cards/{id}/cycle-verdicts")
    public ResponseEntity<?> timeline(@PathVariable String id) {
        return cycles.timeline(id).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such card"));
    }

    record Prefs(Boolean claudeSummaries) {
    }

    @GetMapping("/board/boards/{id}/cycle-prefs")
    public ResponseEntity<?> prefs(@PathVariable String id) {
        return ResponseEntity.ok(Map.of("claudeSummaries", cycles.claudeSummaries(id)));
    }

    @PutMapping("/board/boards/{id}/cycle-prefs")
    public ResponseEntity<?> putPrefs(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                      @RequestBody Prefs body) {
        if (body == null || body.claudeSummaries() == null) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "claudeSummaries: true or false");
        }
        return switch (cycles.setClaudeSummaries(BoardWeb.actor(actor), id, body.claudeSummaries())) {
            case OK -> ResponseEntity.ok(Map.of("claudeSummaries", body.claudeSummaries()));
            case NOT_FOUND -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such board");
            case REFUSED -> BoardWeb.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, "Only the user switches Claude's summaries");
        };
    }

    @PutMapping("/board/boards/{id}/cycles/{cycleId}/flags")
    public ResponseEntity<?> flags(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                   @PathVariable String cycleId, @RequestBody BoardCyclesUseCase.Flags body) {
        return switch (cycles.setFlags(BoardWeb.actor(actor), id, cycleId, body)) {
            case OK -> ResponseEntity.ok(Map.of("ok", true));
            case NOT_FOUND -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "This cycle is not on this board");
            case REFUSED -> BoardWeb.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, "The baseline and archive are the user's to set");
        };
    }
}
