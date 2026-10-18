package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.CycleVerdictsUseCase;
import com.fathy.alfred.backend.board.application.port.in.RecordForBoardUseCase;
import com.fathy.alfred.backend.board.application.port.in.RecordForBoardUseCase.Kind;
import com.fathy.alfred.backend.board.application.port.in.RecordForBoardUseCase.OnRunning;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import java.util.Locale;
import java.util.Map;
import com.fathy.alfred.backend.board.application.port.in.FindingHomeUseCase;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * One cycle shared by several boards (specs/027 US3): every related board's verdicts per call, and where a listen's
 * finding goes (research R5). Read-only.
 */
@RestController
public class CycleSharingController {

    private final CycleVerdictsUseCase verdicts;
    private final FindingHomeUseCase homes;
    private final RecordForBoardUseCase record;
    private final com.fathy.alfred.backend.board.application.port.in.CycleDeletePlanUseCase deletePlan;

    public CycleSharingController(CycleVerdictsUseCase verdicts, FindingHomeUseCase homes, RecordForBoardUseCase record,
                                  com.fathy.alfred.backend.board.application.port.in.CycleDeletePlanUseCase deletePlan) {
        this.verdicts = verdicts;
        this.homes = homes;
        this.record = record;
        this.deletePlan = deletePlan;
    }

    /** What deleting the cycle keeps (FR-017): the calls board texts mention, per board - the delete dialog's dry run. */
    @GetMapping("/board/cycles/{cycleId}/delete-plan")
    public ResponseEntity<?> deletePlan(@PathVariable String cycleId) {
        return ResponseEntity.ok(deletePlan.plan(cycleId));
    }

    record RecordDto(String kind, String onRunning, java.util.List<Integer> cards, String name, String description) {
    }

    /** Records for a board (FR-008): 200 {cycleId}, or 409 {running} when ASK meets a cycle recording the project. */
    @PostMapping("/board/boards/{id}/record")
    public ResponseEntity<?> record(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                    @RequestBody(required = false) RecordDto body) {
        Kind kind;
        OnRunning how;
        try {
            kind = body == null || body.kind() == null ? Kind.REC : Kind.valueOf(body.kind().strip().toUpperCase(Locale.ROOT));
            how = body == null || body.onRunning() == null ? OnRunning.ASK : OnRunning.valueOf(body.onRunning().strip().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return BoardWeb.refused(com.fathy.alfred.backend.board.domain.model.CardChange.Outcome.INVALID, "kind is REC or RETEST; onRunning ASK, JOIN or NEW");
        }
        RecordForBoardUseCase.Spec spec = body == null ? RecordForBoardUseCase.Spec.NONE
                : new RecordForBoardUseCase.Spec(body.cards(), body.name(), body.description());
        return record.record(BoardWeb.actor(actor), id, kind, how, spec).<ResponseEntity<?>>map(r -> {
            if (r.conflict()) {
                return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", "RECORDING_CONFLICT", "message", r.message(), "running", r.running()));
            }
            if (r.cycleId() == null) {
                return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of("error", "unavailable", "message", r.message()));
            }
            return ResponseEntity.ok(Map.of("cycleId", r.cycleId(), "message", r.message()));
        }).orElseGet(() -> BoardWeb.refused(com.fathy.alfred.backend.board.domain.model.CardChange.Outcome.NOT_FOUND, "No such board"));
    }

    @GetMapping("/board/cycles/{cycleId}/verdicts")
    public ResponseEntity<?> verdicts(@PathVariable String cycleId, @RequestParam(required = false) String board,
                                      @RequestParam(defaultValue = "500") int limit) {
        return ResponseEntity.ok(verdicts.verdicts(cycleId, board, limit));
    }

    @GetMapping("/board/cycles/{cycleId}/home")
    public ResponseEntity<?> home(@PathVariable String cycleId, @RequestParam(required = false) String project,
                                  @RequestParam(required = false) String endpoint, @RequestParam(required = false) String signature,
                                  @RequestParam(required = false) String board) {
        return ResponseEntity.ok(homes.resolve(project, cycleId, endpoint, signature, board));
    }
}
