package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.CycleVerdictsUseCase;
import com.fathy.alfred.backend.board.application.service.ListenHomeResolver;
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
    private final ListenHomeResolver homes;

    public CycleSharingController(CycleVerdictsUseCase verdicts, ListenHomeResolver homes) {
        this.verdicts = verdicts;
        this.homes = homes;
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
