package com.fathy.alfred.backend.investigationbridge;

import com.fathy.alfred.backend.investigationbridge.InvestigationModels.EndpointsRequest;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.LogProblemCallsRequest;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.LogProblemsRequest;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.LogSearchRequest;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.ProblemCallsRequest;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.TimelineRequest;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.NoSuchElementException;
import java.util.function.Supplier;

/**
 * Cross-call investigation for Claude's tools (specs/010-mcp-log-investigation, contracts/investigate-api.md). Every
 * endpoint is a POST: its scope and filters travel in the body, never in the URL - the gateway refuses a request line
 * over 8 KB. Under prefixes the gateway already routes to the backend (/triage, /call-logs).
 */
@RestController
public class InvestigationController {

    private final InvestigationService service;

    public InvestigationController(InvestigationService service) {
        this.service = service;
    }

    private static ResponseEntity<?> answer(Supplier<Map<String, Object>> work) {
        try {
            return ResponseEntity.ok(work.get());
        } catch (NoSuchElementException e) {
            return ResponseEntity.status(404).body(Map.of("error", e.getMessage()));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/triage/problem-calls")
    public ResponseEntity<?> problemCalls(@Valid @RequestBody ProblemCallsRequest body) {
        return answer(() -> service.problemCalls(body));
    }

    @PostMapping("/triage/endpoints")
    public ResponseEntity<?> endpoints(@Valid @RequestBody EndpointsRequest body) {
        return answer(() -> service.endpoints(body));
    }

    @PostMapping("/triage/timeline")
    public ResponseEntity<?> timeline(@Valid @RequestBody TimelineRequest body) {
        return answer(() -> service.timeline(body));
    }

    @PostMapping("/call-logs/search")
    public ResponseEntity<?> search(@Valid @RequestBody LogSearchRequest body) {
        return answer(() -> service.search(body));
    }

    @PostMapping("/call-logs/problems")
    public ResponseEntity<?> problems(@Valid @RequestBody LogProblemsRequest body) {
        return answer(() -> service.problems(body));
    }

    @PostMapping("/call-logs/problems/calls")
    public ResponseEntity<?> problemCallsOf(@Valid @RequestBody LogProblemCallsRequest body) {
        return answer(() -> service.problemCallsOf(body));
    }

    /** A malformed body (an unknown field type, bad JSON) answers like a bad filter. */
    @ExceptionHandler(org.springframework.http.converter.HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, String>> unreadable(org.springframework.http.converter.HttpMessageNotReadableException e) {
        return ResponseEntity.badRequest().body(Map.of("error", "the request body could not be read"));
    }
}
