package com.fathy.alfred.backend.sessioncycles.adapter.in.web;

import com.fathy.alfred.backend.sessioncycles.application.port.in.CycleNotesUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSummary;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * A cycle's notes and summary (specs/033): {@code PUT /session-cycles/{id}/notes} sets the description and/or Claude's
 * summary (a missing field is left alone, "" clears it); {@code GET /session-cycles/{id}/summary} counts what it caught.
 */
@RestController
@RequestMapping("/session-cycles")
public class CycleNotesController {

    private final CycleNotesUseCase notes;

    public CycleNotesController(CycleNotesUseCase notes) {
        this.notes = notes;
    }

    public record NotesRequest(String description, String summary) {
    }

    @PutMapping("/{id}/notes")
    public ResponseEntity<?> putNotes(@PathVariable String id, @RequestBody NotesRequest request) {
        try {
            return notes.updateNotes(id, request.description(), request.summary())
                    .<ResponseEntity<?>>map(ResponseEntity::ok)
                    .orElseGet(() -> ResponseEntity.notFound().build());
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", "TOO_LONG", "message", e.getMessage()));
        }
    }

    @GetMapping("/{id}/summary")
    public ResponseEntity<CycleSummary> summary(@PathVariable String id) {
        return notes.summary(id).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }
}
