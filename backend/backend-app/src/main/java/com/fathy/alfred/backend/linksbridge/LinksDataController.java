package com.fathy.alfred.backend.linksbridge;

import com.fathy.alfred.backend.board.application.port.out.CallFactsPort;
import com.fathy.alfred.backend.board.application.port.out.CycleCallsPort;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * What a reader's board judges a streamed cycle with (D25), answered here by the owner with its own board adapters - the
 * same signatures and facts its own board uses, so a requirement is judged the same on both Alfreds. Read only through
 * a stream (StreamRoutes "links/data"), refused to anyone else by the scope check like every streamed read.
 */
@RestController
public class LinksDataController {

    public record CycleInfo(String id, String name, String project, boolean recording, String status) {
    }

    private final ObjectProvider<GetSessionCycleUseCase> cycles;
    private final ObjectProvider<CycleCallsPort> cycleCalls;
    private final ObjectProvider<CallFactsPort> facts;
    private final ObjectProvider<com.fathy.alfred.backend.links.application.port.in.LinksUseCase> links;
    private final ObjectProvider<com.fathy.alfred.backend.links.application.port.in.EnvUseCase> envs;
    private final ObjectProvider<LinksEnvBoard> envBoard;

    public LinksDataController(ObjectProvider<GetSessionCycleUseCase> cycles, ObjectProvider<CycleCallsPort> cycleCalls,
                               ObjectProvider<CallFactsPort> facts,
                               ObjectProvider<com.fathy.alfred.backend.links.application.port.in.LinksUseCase> links,
                               ObjectProvider<com.fathy.alfred.backend.links.application.port.in.EnvUseCase> envs,
                               ObjectProvider<LinksEnvBoard> envBoard) {
        this.cycles = cycles;
        this.cycleCalls = cycleCalls;
        this.facts = facts;
        this.links = links;
        this.envs = envs;
        this.envBoard = envBoard;
    }

    /**
     * An environment Alfred's re-test (D40), judged here by the host's own re-test code on that Alfred's cycle - read
     * over the link as this Alfred's own read (the environment's cycle is streamed to the host), never as passed on.
     */
    @GetMapping("/links/data/env-judge")
    public ResponseEntity<?> envJudge(@RequestParam String boardId, @RequestParam String cycleId, @RequestParam(defaultValue = "") String cards) {
        java.util.Optional<RelayContext.Current> asker = RelayContext.current();
        var l = links.getIfAvailable();
        var e = envs.getIfAvailable();
        if (asker.isEmpty() || l == null || e == null) {
            return ResponseEntity.status(403).body(Map.of("error", "NOT_ALLOWED", "message", "Only an environment Alfred asks for this"));
        }
        var link = l.byId(asker.get().linkId()).orElse(null);
        boolean assigned = link != null && e.envs(boardId).stream().anyMatch(d -> link.id().equals(d.linkId()));
        if (!assigned) {
            return ResponseEntity.status(403).body(Map.of("error", "NOT_ASSIGNED", "message", "This Alfred gave you no environment of that board"));
        }
        List<Integer> numbers = Arrays.stream(cards.split(",")).map(String::trim).filter(s -> s.matches("[0-9]+")).map(Integer::parseInt).toList();
        RelayContext.clear();
        try {
            return ResponseEntity.ok(envBoard.getObject().judgeHere(boardId, numbers, cycleId + "@" + link.slug()));
        } finally {
            RelayContext.set(asker.get());
        }
    }

    @GetMapping("/links/data/cycle")
    public ResponseEntity<?> cycle(@RequestParam String cycleId) {
        GetSessionCycleUseCase g = cycles.getIfAvailable();
        if (g == null) {
            return ResponseEntity.notFound().build();
        }
        return g.getById(cycleId)
                .<ResponseEntity<?>>map(c -> ResponseEntity.ok(new CycleInfo(c.id(), c.name(), c.assignedTo(), c.status() == SessionCycleStatus.RECORDING,
                        c.status() == null ? null : c.status().name())))
                .orElseGet(() -> ResponseEntity.status(404).body(Map.of("error", "NOT_FOUND", "message", "No such cycle")));
    }

    @GetMapping("/links/data/cycle-calls")
    public List<CycleCall> cycleCalls(@RequestParam String cycleId, @RequestParam(defaultValue = "5000") int limit) {
        CycleCallsPort p = cycleCalls.getIfAvailable();
        return p == null ? List.of() : p.ofCycle(cycleId, Math.max(1, Math.min(limit, 20_000)));
    }

    @GetMapping("/links/data/call-facts")
    public ResponseEntity<?> callFacts(@RequestParam String callId, @RequestParam String cycleId, @RequestParam(defaultValue = "") String paths) {
        CallFactsPort p = facts.getIfAvailable();
        if (p == null) {
            return ResponseEntity.notFound().build();
        }
        Set<String> jsonPaths = new LinkedHashSet<>();
        Arrays.stream(paths.split("\n")).map(String::trim).filter(s -> !s.isEmpty()).forEach(jsonPaths::add);
        return p.facts(callId, cycleId, jsonPaths).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.status(404).body(Map.of("error", "NOT_FOUND", "message", "No such call")));
    }

    @GetMapping("/links/data/call-bodies")
    public ResponseEntity<?> callBodies(@RequestParam String callId, @RequestParam String cycleId) {
        CallFactsPort p = facts.getIfAvailable();
        if (p == null) {
            return ResponseEntity.notFound().build();
        }
        return p.bodies(callId, cycleId).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.status(404).body(Map.of("error", "NOT_FOUND", "message", "No such call")));
    }
}
