package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.RequirementUseCase;
import com.fathy.alfred.backend.board.application.port.in.ShortNameUseCase;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Short names (specs/021): the few words a mention of a card or an Acceptance item reads - "one-branch search (AC8)".
 * Under /board, so the board's edit access applies.
 */
@RestController
public class ShortNameController {

    private final ShortNameUseCase cards;
    private final RequirementUseCase items;

    public ShortNameController(ShortNameUseCase cards, RequirementUseCase items) {
        this.cards = cards;
        this.items = items;
    }

    public record CardNameDto(String shortName) {
    }

    public record ItemNameDto(String fileName, String itemKey, String shortName) {
    }

    @PutMapping("/board/cards/{id}/short-name")
    public ResponseEntity<?> card(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                  @RequestBody CardNameDto body) {
        return BoardWeb.respond(cards.setShortName(BoardWeb.actor(actor), id, body == null ? null : body.shortName()), HttpStatus.OK);
    }

    @PutMapping("/board/cycles/{cycleId}/requirements/short-name")
    public ResponseEntity<?> item(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String cycleId,
                                  @RequestBody ItemNameDto body) {
        if (body == null || body.fileName() == null || body.itemKey() == null) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "fileName and itemKey are required");
        }
        RequirementUseCase.NameChange change = items.setShortName(BoardWeb.actor(actor), cycleId, body.fileName(), body.itemKey(), body.shortName());
        if (change.outcome() != CardChange.Outcome.OK) {
            return BoardWeb.refused(change.outcome(), change.message());
        }
        return ResponseEntity.ok(Map.of("shortName", body.shortName() == null ? "" : body.shortName().strip()));
    }
}
