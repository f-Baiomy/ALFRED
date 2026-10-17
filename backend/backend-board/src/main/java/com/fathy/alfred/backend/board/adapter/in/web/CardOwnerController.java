package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.CardOwnerUseCase;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Card owners and a person's cards (specs/028 FR-089). Under /board, so the board's edit access applies. */
@RestController
public class CardOwnerController {

    private final CardOwnerUseCase owners;

    public CardOwnerController(CardOwnerUseCase owners) {
        this.owners = owners;
    }

    public record OwnerDto(String owner) {
    }

    @GetMapping("/board/cards/{id}/owner")
    public ResponseEntity<?> owner(@PathVariable String id) {
        Map<String, Object> out = new HashMap<>();
        out.put("owner", owners.owner(id).orElse(null));
        return ResponseEntity.ok(out);
    }

    @PutMapping("/board/cards/{id}/owner")
    public ResponseEntity<?> setOwner(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                      @RequestBody(required = false) OwnerDto body) {
        return BoardWeb.respond(owners.setOwner(BoardWeb.actor(actor), id, body == null ? null : body.owner()), HttpStatus.OK);
    }

    /** The owners of many cards at once (a board's columns, at most 200 ids a call). */
    @GetMapping("/board/owners")
    public ResponseEntity<?> owners(@RequestParam(defaultValue = "") String ids) {
        List<String> list = java.util.Arrays.stream(ids.split(",")).map(String::strip).filter(s -> !s.isEmpty()).limit(200).toList();
        return ResponseEntity.ok(owners.owners(list));
    }

    @GetMapping("/board/people/{conn}/{person}/cards")
    public ResponseEntity<?> cardsOf(@PathVariable String conn, @PathVariable String person, @RequestParam(defaultValue = "50") int limit) {
        return ResponseEntity.ok(owners.cardsOf(conn + "/" + person, limit));
    }
}
