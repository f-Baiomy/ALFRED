package com.fathy.alfred.backend.triage.adapter.in.web;

import com.fathy.alfred.backend.triage.application.port.in.QueryAttentionUseCase;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * Triage reads. Read-only: the marks are written by backend-app/triagebridge as calls arrive.
 *
 * <ul>
 *   <li>{@code GET /triage/calls?callIds=a,b&minStatus=300} - those calls' marks with their failing supplier calls</li>
 *   <li>{@code GET /triage/live?project=&since=&to=&maxPriority=5&minStatus=300&limit=200} - newest first</li>
 *   <li>{@code GET /triage/counts?project=&since=&to=} - calls per priority</li>
 * </ul>
 * {@code since}/{@code to} are ISO-8601 instants; {@code since} defaults to an hour ago.
 */
@RestController
public class TriageController {

    private final QueryAttentionUseCase query;

    public TriageController(QueryAttentionUseCase query) {
        this.query = query;
    }

    @GetMapping("/triage/calls")
    public ResponseEntity<?> calls(@RequestParam(defaultValue = "") String callIds, @RequestParam(required = false) Integer minStatus) {
        List<String> ids = Arrays.stream(callIds.split(",")).map(String::strip).filter(s -> !s.isEmpty()).toList();
        try {
            return ResponseEntity.ok(query.forCalls(ids, minStatus));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/triage/live")
    public ResponseEntity<?> live(@RequestParam(required = false) String project, @RequestParam(required = false) String since,
                                  @RequestParam(required = false) String to, @RequestParam(defaultValue = "5") int maxPriority,
                                  @RequestParam(required = false) Integer minStatus, @RequestParam(defaultValue = "200") int limit) {
        try {
            return ResponseEntity.ok(query.live(project, instant(since), instant(to), maxPriority, minStatus, limit));
        } catch (DateTimeParseException e) {
            return ResponseEntity.badRequest().body(Map.of("error", "since/to must be ISO-8601 instants: " + e.getParsedString()));
        }
    }

    @GetMapping("/triage/counts")
    public ResponseEntity<?> counts(@RequestParam(required = false) String project, @RequestParam(required = false) String since,
                                    @RequestParam(required = false) String to) {
        try {
            return ResponseEntity.ok(query.counts(project, instant(since), instant(to)));
        } catch (DateTimeParseException e) {
            return ResponseEntity.badRequest().body(Map.of("error", "since/to must be ISO-8601 instants: " + e.getParsedString()));
        }
    }

    private static Instant instant(String value) {
        return value == null || value.isBlank() ? null : Instant.parse(value);
    }
}
