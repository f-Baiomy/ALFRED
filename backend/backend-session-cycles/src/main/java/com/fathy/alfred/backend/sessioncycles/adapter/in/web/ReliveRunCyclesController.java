package com.fathy.alfred.backend.sessioncycles.adapter.in.web;

import com.fathy.alfred.backend.sessioncycles.application.port.in.ReliveRunCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.ReliveRunCycle;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * A Relive run's own session cycle, opened from that run's History in the Relive page. Everything
 * else about the cycle - its calls, spacers, exports, renaming - goes through the ordinary
 * {@code /session-cycles/{id}} endpoints with the id this returns.
 */
@RestController
@RequestMapping("/session-cycles/relive-runs")
public class ReliveRunCyclesController {

    private final ReliveRunCyclesUseCase runCycles;

    public ReliveRunCyclesController(ReliveRunCyclesUseCase runCycles) {
        this.runCycles = runCycles;
    }

    /** The run's cycle - created and filled from the call logs the first time a run from before
     *  run cycles is opened. {@code name} and {@code reliveCycleId} are applied when given. */
    @PostMapping("/{runId}")
    public ResponseEntity<ReliveRunCycle> open(@PathVariable String runId, @RequestBody(required = false) OpenRequest request) {
        if (runId == null || runId.isBlank()) {
            return ResponseEntity.badRequest().build();
        }
        String name = request == null ? null : request.name();
        String reliveCycleId = request == null ? null : request.reliveCycleId();
        return ResponseEntity.ok(runCycles.open(runId, name, reliveCycleId));
    }

    public record OpenRequest(String name, String reliveCycleId) {
    }
}
