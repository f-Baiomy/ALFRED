package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.BoardStageUseCase;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** The board's stage in the workflow and its next step (specs/030, step since specs/032): the board header, task_context's NEXT/STEP, /alfred-guide. */
@RestController
public class BoardStageController {

    private final BoardStageUseCase stages;

    public BoardStageController(BoardStageUseCase stages) {
        this.stages = stages;
    }

    @GetMapping("/board/boards/{id}/stage")
    public ResponseEntity<?> stage(@PathVariable String id) {
        return stages.stage(id).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such board"));
    }
}
