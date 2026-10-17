package com.fathy.alfred.backend.teamboards.core.adapter.in.web;

import com.fathy.alfred.backend.teamboards.core.application.port.in.SavedSearchesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase.SearchIn;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** Saved searches (specs/029): the Team tab's pills. Reading is everyone's; saving, changing, moving and deleting the user's. */
@RestController
public class SavedSearchesController {

    private static final String ACTOR = TeamboardsController.ACTOR_HEADER;

    private final SavedSearchesUseCase saved;

    public SavedSearchesController(SavedSearchesUseCase saved) {
        this.saved = saved;
    }

    record NewDto(@NotBlank @Size(max = 200) String name, SearchIn query) {
    }

    record EditDto(@Size(max = 200) String name, SearchIn query) {
    }

    record MoveDto(int by) {
    }

    @GetMapping("/teamboards/connections/{id}/saved")
    public ResponseEntity<?> list(@PathVariable String id) {
        return ResponseEntity.ok(saved.list(id));
    }

    @PostMapping("/teamboards/connections/{id}/saved")
    public ResponseEntity<?> create(@PathVariable String id, @Valid @RequestBody NewDto body,
                                    @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.status(HttpStatus.CREATED).body(saved.create(Who.of(actor), id, body.name(), body.query()));
    }

    @GetMapping("/teamboards/saved/{sid}")
    public ResponseEntity<?> get(@PathVariable long sid) {
        return ResponseEntity.ok(saved.get(sid));
    }

    @PatchMapping("/teamboards/saved/{sid}")
    public ResponseEntity<?> update(@PathVariable long sid, @Valid @RequestBody EditDto body,
                                    @RequestHeader(value = ACTOR, required = false) String actor) {
        if (body.name() == null && body.query() == null) {
            throw TeamException.invalid("Send a new name, a new search, or both");
        }
        return ResponseEntity.ok(saved.update(Who.of(actor), sid, body.name(), body.query()));
    }

    @PostMapping("/teamboards/saved/{sid}/move")
    public ResponseEntity<?> move(@PathVariable long sid, @RequestBody MoveDto body, @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(saved.move(Who.of(actor), sid, body.by()));
    }

    @DeleteMapping("/teamboards/saved/{sid}")
    public ResponseEntity<?> delete(@PathVariable long sid, @RequestHeader(value = ACTOR, required = false) String actor) {
        return saved.delete(Who.of(actor), sid) ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}
