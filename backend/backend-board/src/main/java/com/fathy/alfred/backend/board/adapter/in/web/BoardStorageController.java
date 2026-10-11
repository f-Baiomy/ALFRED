package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.BoardStorageUseCase;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** Settings -> Storage -> Board: board.db's size and free space, and Compact. */
@RestController
public class BoardStorageController {

    private final BoardStorageUseCase storage;

    public BoardStorageController(BoardStorageUseCase storage) {
        this.storage = storage;
    }

    @GetMapping("/board/storage")
    public ResponseEntity<?> storage() {
        return ResponseEntity.ok(storage.storage());
    }

    @PostMapping("/board/storage/compact")
    public ResponseEntity<?> compact(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        BoardStorageUseCase.Compacted out = storage.compact(BoardWeb.actor(actor));
        if (out.outcome() != CardChange.Outcome.OK) {
            return BoardWeb.refused(out.outcome(), out.message());
        }
        return ResponseEntity.ok(Map.of("before", out.before(), "after", out.after()));
    }
}
