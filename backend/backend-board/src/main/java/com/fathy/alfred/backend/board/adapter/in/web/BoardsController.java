package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase.NewBoard;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase.Result;
import com.fathy.alfred.backend.board.application.port.in.MoveCardHomeUseCase;
import com.fathy.alfred.backend.board.application.port.in.RelateCycleUseCase;
import com.fathy.alfred.backend.board.domain.model.BoardOutcome;
import com.fathy.alfred.backend.board.domain.model.BoardState;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.CardChange;
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
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Boards as tasks (specs/027 contracts/board-rest.md): list, open, rename, state, delete, relations, activity and Undo,
 * and a card's home and related cycles. Writes sit behind the board edit rule (boardbridge), so the tunnel can never make
 * them; Claude's limits are the service's.
 */
@RestController
public class BoardsController {

    private static final String ACTOR = BoardWeb.ACTOR_HEADER;

    private final ManageBoardsUseCase boards;
    private final RelateCycleUseCase relations;
    private final MoveCardHomeUseCase homes;

    public BoardsController(ManageBoardsUseCase boards, RelateCycleUseCase relations, MoveCardHomeUseCase homes) {
        this.boards = boards;
        this.relations = relations;
        this.homes = homes;
    }

    record NewBoardDto(@NotBlank @Size(max = 200) String project, @NotBlank @Size(max = Board.MAX_NAME) String name,
                       @Size(max = 100) List<@Size(max = 200) String> cycleIds, @Size(max = 200) String relateTo, boolean startRecording,
                       @Size(max = 40) String askedIn) {
    }

    record UpdateBoardDto(@Size(max = Board.MAX_NAME) String name, String state) {
    }

    record HomeDto(@NotBlank @Size(max = 200) String boardId) {
    }

    @GetMapping("/board/boards")
    public ResponseEntity<?> list(@RequestParam(required = false) String project, @RequestParam(required = false) List<String> state,
                                  @RequestParam(required = false) String q, @RequestParam(defaultValue = "2000") int limit) {
        Set<BoardState> states = EnumSet.noneOf(BoardState.class);
        try {
            if (state != null) {
                state.stream().filter(s -> !s.isBlank()).forEach(s -> states.add(BoardState.valueOf(s.strip().toUpperCase(Locale.ROOT))));
            }
        } catch (IllegalArgumentException e) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "Unknown board state");
        }
        return ResponseEntity.ok(boards.list(project, states, q, limit));
    }

    @GetMapping("/board/boards/{id}")
    public ResponseEntity<?> get(@PathVariable String id) {
        return boards.get(id).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such board"));
    }

    @PostMapping("/board/boards")
    public ResponseEntity<?> create(@RequestHeader(value = ACTOR, required = false) String actor, @Valid @RequestBody NewBoardDto body) {
        Result r = boards.create(BoardWeb.actor(actor), new NewBoard(body.project().strip(), body.name(), body.cycleIds(), body.relateTo(),
                body.startRecording(), body.askedIn()));
        return respond(r, HttpStatus.CREATED);
    }

    @PatchMapping("/board/boards/{id}")
    public ResponseEntity<?> update(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                    @Valid @RequestBody UpdateBoardDto body) {
        BoardState state;
        try {
            state = body.state() == null || body.state().isBlank() ? null : BoardState.valueOf(body.state().strip().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "Unknown board state");
        }
        return respond(boards.update(BoardWeb.actor(actor), id, body.name(), state), HttpStatus.OK);
    }

    @DeleteMapping("/board/boards/{id}")
    public ResponseEntity<?> delete(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id) {
        Result r = boards.delete(BoardWeb.actor(actor), id);
        return r.outcome() == BoardOutcome.OK ? ResponseEntity.noContent().build() : respond(r, HttpStatus.OK);
    }

    @GetMapping("/board/boards/{id}/activity")
    public ResponseEntity<?> activity(@PathVariable String id, @RequestParam(defaultValue = "0") long after,
                                      @RequestParam(defaultValue = "100") int limit) {
        return ResponseEntity.ok(boards.activity(id, after, limit));
    }

    @PostMapping("/board/boards/{id}/activity/{activityId}/undo")
    public ResponseEntity<?> undo(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                  @PathVariable long activityId) {
        return respond(boards.undo(BoardWeb.actor(actor), id, activityId), HttpStatus.OK);
    }

    // ------------------------------------------------------------------------------------------------------- relations

    @PutMapping("/board/boards/{id}/cycles/{cycleId}")
    public ResponseEntity<?> relateCycle(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                         @PathVariable String cycleId) {
        return respond(relations.relateCycle(BoardWeb.actor(actor), id, cycleId), HttpStatus.OK);
    }

    @DeleteMapping("/board/boards/{id}/cycles/{cycleId}")
    public ResponseEntity<?> unrelateCycle(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                           @PathVariable String cycleId) {
        return respond(relations.unrelateCycle(BoardWeb.actor(actor), id, cycleId), HttpStatus.OK);
    }

    @PutMapping("/board/boards/{id}/boards/{otherId}")
    public ResponseEntity<?> relateBoard(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                         @PathVariable String otherId) {
        return respond(relations.relateBoard(BoardWeb.actor(actor), id, otherId), HttpStatus.OK);
    }

    @DeleteMapping("/board/boards/{id}/boards/{otherId}")
    public ResponseEntity<?> unrelateBoard(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                           @PathVariable String otherId) {
        return respond(relations.unrelateBoard(BoardWeb.actor(actor), id, otherId), HttpStatus.OK);
    }

    @GetMapping("/board/cycles/{cycleId}/boards")
    public ResponseEntity<?> boardsOfCycle(@PathVariable String cycleId) {
        return ResponseEntity.ok(relations.boardsOfCycle(cycleId).stream().map(boards::get).flatMap(java.util.Optional::stream).toList());
    }

    // ------------------------------------------------------------------------------------------------------- card homes

    @PutMapping("/board/cards/{id}/home")
    public ResponseEntity<?> moveHome(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                      @Valid @RequestBody HomeDto body) {
        return BoardWeb.respond(homes.moveHome(BoardWeb.actor(actor), id, body.boardId().strip()), HttpStatus.OK);
    }

    @GetMapping("/board/cards/{id}/cycles")
    public ResponseEntity<?> cardCycles(@PathVariable String id) {
        return ResponseEntity.ok(homes.relatedCycles(id));
    }

    record CardIdsDto(@jakarta.validation.constraints.NotNull @jakarta.validation.constraints.Size(max = 5000) java.util.List<String> ids) {
    }

    /** The related cycles of many cards (the board export); a read, so a POST only for the size of the id list. */
    @PostMapping("/board/cards/cycles")
    public ResponseEntity<?> cardsCycles(@Valid @RequestBody CardIdsDto body) {
        return ResponseEntity.ok(homes.relatedCycles(body.ids()));
    }

    @PutMapping("/board/cards/{id}/cycles/{cycleId}")
    public ResponseEntity<?> relateCardCycle(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                             @PathVariable String cycleId) {
        return BoardWeb.respond(homes.relateCardCycle(BoardWeb.actor(actor), id, cycleId), HttpStatus.OK);
    }

    @DeleteMapping("/board/cards/{id}/cycles/{cycleId}")
    public ResponseEntity<?> unrelateCardCycle(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                               @PathVariable String cycleId) {
        return BoardWeb.respond(homes.unrelateCardCycle(BoardWeb.actor(actor), id, cycleId), HttpStatus.OK);
    }

    static ResponseEntity<?> respond(Result r, HttpStatus ok) {
        HttpStatus status = switch (r.outcome()) {
            case OK -> ok;
            case NOT_FOUND -> HttpStatus.NOT_FOUND;
            case NOT_ASKED -> HttpStatus.FORBIDDEN;
            case REFUSED -> HttpStatus.BAD_REQUEST;
            case DEFAULT_PROTECTED, REFUSED_FOR_CLAUDE -> HttpStatus.CONFLICT;
        };
        if (r.outcome() == BoardOutcome.OK) {
            return r.board() == null ? ResponseEntity.status(status).build() : ResponseEntity.status(status).body(r.board());
        }
        return ResponseEntity.status(status).body(Map.of("error", r.outcome().name().toLowerCase(Locale.ROOT).replace('_', '-'),
                "message", r.message() == null ? "" : r.message()));
    }
}
