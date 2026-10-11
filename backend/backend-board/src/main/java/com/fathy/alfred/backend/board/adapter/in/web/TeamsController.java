package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.AssignTeamsRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.TeamOrderRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.TeamRequestDto;
import com.fathy.alfred.backend.board.application.port.in.AssignTeamsUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageTeamsUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageTeamsUseCase.TeamEdit;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** Settings → Teams, and a card's teams. Under /board, so the board's edit access applies to every write. */
@RestController
public class TeamsController {

    private final ManageTeamsUseCase teams;
    private final AssignTeamsUseCase assign;

    public TeamsController(ManageTeamsUseCase teams, AssignTeamsUseCase assign) {
        this.teams = teams;
        this.assign = assign;
    }

    @GetMapping("/board/teams")
    public ResponseEntity<?> list() {
        return ResponseEntity.ok(teams.teams());
    }

    @PostMapping("/board/teams")
    public ResponseEntity<?> create(@Valid @RequestBody TeamRequestDto body) {
        return save(null, body, HttpStatus.CREATED);
    }

    @PutMapping("/board/teams/{id}")
    public ResponseEntity<?> update(@PathVariable String id, @Valid @RequestBody TeamRequestDto body) {
        return save(id, body, HttpStatus.OK);
    }

    @DeleteMapping("/board/teams/{id}")
    public ResponseEntity<?> delete(@PathVariable String id) {
        return teams.delete(id) ? ResponseEntity.noContent().build() : BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such team");
    }

    @PutMapping("/board/teams/order")
    public ResponseEntity<?> reorder(@Valid @RequestBody TeamOrderRequestDto body) {
        return ResponseEntity.ok(teams.reorder(body.ids()));
    }

    @PutMapping("/board/cards/{id}/teams")
    public ResponseEntity<?> assign(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                    @Valid @RequestBody AssignTeamsRequestDto body) {
        return BoardWeb.respond(assign.assignTeams(BoardWeb.actor(actor), id, body.teams(), body.reason()), HttpStatus.OK);
    }

    private ResponseEntity<?> save(String id, TeamRequestDto body, HttpStatus ok) {
        try {
            return ResponseEntity.status(ok).body(teams.save(new TeamEdit(id, body.name(), body.color(), body.icon(), body.owns(), body.hints())));
        } catch (IllegalArgumentException e) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, e.getMessage());
        }
    }
}
