package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.RequirementUseCase;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.EvidenceCheck;
import com.fathy.alfred.backend.board.domain.model.ItemEvidence;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * The requirement check (specs/018): a cycle's Acceptance items with the evidence that shows each and where each stands
 * by the calls. Reading judges what is new first, so a cycle recorded before the evidence was written is judged too.
 */
@RestController
public class RequirementController {

    private final RequirementUseCase requirements;

    public RequirementController(RequirementUseCase requirements) {
        this.requirements = requirements;
    }

    @GetMapping("/board/cycles/{cycleId}/requirements")
    public ResponseEntity<?> requirements(@PathVariable String cycleId) {
        return ResponseEntity.ok(requirements.requirements(cycleId));
    }

    @GetMapping("/board/cycles/{cycleId}/evidence")
    public ResponseEntity<?> evidence(@PathVariable String cycleId) {
        return ResponseEntity.ok(Map.of("evidence", requirements.evidence(cycleId)));
    }

    public record EvidenceDto(String fileName, String itemKey, String project, String endpoint, List<EvidenceCheck> checks, String howTo) {
    }

    @PutMapping("/board/cycles/{cycleId}/evidence")
    public ResponseEntity<?> put(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String cycleId,
                                 @RequestBody EvidenceDto body) {
        if (body == null) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "A body is required");
        }
        RequirementUseCase.EvidenceChange change = requirements.putEvidence(BoardWeb.actor(actor), new ItemEvidence(cycleId, body.fileName(),
                body.itemKey(), body.project(), body.endpoint(), body.checks(), body.howTo(), null, null));
        if (change.outcome() != CardChange.Outcome.OK) {
            return BoardWeb.refused(change.outcome(), change.message());
        }
        return ResponseEntity.ok(change.evidence());
    }

    @DeleteMapping("/board/cycles/{cycleId}/evidence")
    public ResponseEntity<?> delete(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String cycleId,
                                    @RequestParam String fileName, @RequestParam String itemKey) {
        RequirementUseCase.EvidenceChange change = requirements.deleteEvidence(BoardWeb.actor(actor), cycleId, fileName, itemKey);
        if (change.outcome() != CardChange.Outcome.OK) {
            return BoardWeb.refused(change.outcome(), change.message());
        }
        return ResponseEntity.noContent().build();
    }
}
