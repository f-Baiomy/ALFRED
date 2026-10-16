package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.RetestUseCase;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.Expectation;
import com.fathy.alfred.backend.board.domain.model.RetestPlan;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Re-testing fixes (specs/016): Fixed cards checked against the live calls since each fix or a re-test cycle, a run that
 * records each card's re-test and returns the report, guards on Verified / Done cards, and one card's plan, check and
 * history for the drawer.
 */
@RestController
public class RetestController {

    private final RetestUseCase retest;

    public RetestController(RetestUseCase retest) {
        this.retest = retest;
    }

    @GetMapping("/board/retest")
    public ResponseEntity<?> check(@RequestParam(defaultValue = "") String project, @RequestParam(defaultValue = "") String numbers,
                                   @RequestParam(required = false) String cycleId) {
        List<Integer> parsed = numbers(numbers);
        if (parsed == null) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "numbers is a comma-separated list of card numbers");
        }
        Map<String, Object> out = new HashMap<>();
        out.put("checks", retest.check(project, parsed, blank(cycleId)));
        out.put("lastStart", retest.lastStart(project).orElse(null));
        return ResponseEntity.ok(out);
    }

    public record RunRequestDto(String project, List<Integer> numbers, String cycleId) {
    }

    @PostMapping("/board/retest/run")
    public ResponseEntity<?> run(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @RequestBody RunRequestDto body) {
        List<Integer> numbers = body.numbers() == null ? List.of() : body.numbers();
        if (numbers.size() > RetestUseCase.MAX_CARDS) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "At most " + RetestUseCase.MAX_CARDS + " cards per re-test");
        }
        return ResponseEntity.ok(retest.run(BoardWeb.actor(actor), body.project() == null ? "" : body.project(), numbers, blank(body.cycleId())));
    }

    @GetMapping("/board/retest/guards")
    public ResponseEntity<?> guards(@RequestParam(defaultValue = "") String project) {
        return ResponseEntity.ok(retest.guards(project));
    }

    @GetMapping("/board/cards/{id}/retest")
    public ResponseEntity<?> card(@PathVariable String id, @RequestParam(required = false) String cycleId) {
        return retest.checkCard(id, blank(cycleId)).<ResponseEntity<?>>map(check -> {
            Map<String, Object> out = new HashMap<>();
            out.put("plan", retest.plan(id));
            out.put("check", check);
            out.put("history", retest.history(id));
            out.put("lastStart", retest.lastStart(check.project()).orElse(null));
            return ResponseEntity.ok(out);
        }).orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such card"));
    }

    public record CodeRequestDto(String verdict, String commit, String branch, List<com.fathy.alfred.backend.board.domain.model.CodeCheck.Layer> layers,
                                 String tests, String note) {
    }

    /** Is the card's fix implemented (specs/026): what Claude found in the code and git, shown beside the re-test of the calls. */
    @PutMapping("/board/cards/{id}/code-check")
    public ResponseEntity<?> code(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                  @RequestBody CodeRequestDto body) {
        RetestUseCase.CodeChange change = retest.recordCode(BoardWeb.actor(actor), id,
                new RetestUseCase.CodeIn(body.verdict(), body.commit(), body.branch(), body.layers(), body.tests(), body.note()));
        return change.outcome() == CardChange.Outcome.OK ? ResponseEntity.ok(change.check()) : BoardWeb.refused(change.outcome(), change.message());
    }

    public record PlanRequestDto(List<Expectation> expectations, List<RetestPlan.Step> steps) {
    }

    @PutMapping("/board/cards/{id}/retest-plan")
    public ResponseEntity<?> plan(@RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor, @PathVariable String id,
                                  @RequestBody PlanRequestDto body) {
        RetestUseCase.PlanChange change = retest.setPlan(BoardWeb.actor(actor), id, body.expectations(), body.steps());
        if (change.outcome() != CardChange.Outcome.OK) {
            return BoardWeb.refused(change.outcome(), change.message());
        }
        if (change.warnings().isEmpty()) {
            return new ResponseEntity<>(change.plan(), HttpStatus.OK);
        }
        // the plan as before, with what will keep a step from ticking (specs/020)
        Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("cardId", change.plan().cardId());
        out.put("expectations", change.plan().expectations());
        out.put("steps", change.plan().steps());
        out.put("updatedBy", change.plan().updatedBy());
        out.put("updatedAt", change.plan().updatedAt());
        out.put("warnings", change.warnings());
        return new ResponseEntity<>(out, HttpStatus.OK);
    }

    private static String blank(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    /** "18, 19" → [18, 19]; "" → []; null when a part is not a number. */
    static List<Integer> numbers(String text) {
        List<Integer> out = new ArrayList<>();
        for (String part : text.split(",")) {
            String p = part.trim().replaceFirst("^#", "");
            if (p.isEmpty()) {
                continue;
            }
            try {
                out.add(Integer.parseInt(p));
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return out.size() > RetestUseCase.MAX_CARDS ? null : out;
    }
}
