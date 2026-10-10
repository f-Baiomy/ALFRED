package com.fathy.alfred.backend.board.adapter.in.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fathy.alfred.backend.board.application.port.in.ImportBoardUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/** {@code POST /board/import?project=} with an alfred-board/1 file as the body, read line by line (never whole). */
@RestController
public class BoardImportController {

    private final ImportBoardUseCase imports;

    public BoardImportController(ImportBoardUseCase imports) {
        this.imports = imports;
    }

    @PostMapping("/board/import")
    public ResponseEntity<?> importBoard(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor,
                                         @RequestParam(defaultValue = "") String project, HttpServletRequest request) throws IOException {
        if (BoardWeb.actor(actor) == Actor.CLAUDE) {
            return BoardWeb.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, "Only the user imports a board");
        }
        try (BufferedReader lines = new BufferedReader(new InputStreamReader(request.getInputStream(), StandardCharsets.UTF_8))) {
            return ResponseEntity.ok(imports.importBoard(project, lines));
        } catch (JsonProcessingException e) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "Not a readable board export: " + e.getOriginalMessage());
        } catch (IllegalArgumentException e) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, e.getMessage());
        }
    }
}
