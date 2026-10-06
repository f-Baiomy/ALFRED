package com.fathy.alfred.backend.dbcapture.adapter.in.web;

import com.fathy.alfred.backend.dbcapture.application.port.in.CallLogLinesUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Log lines the agent caught outside any call (specs/009-agent-log-capture, US4) - the database window's "outside any
 * call" view shows them per thread. A call's own lines are served by /call-logs (the bridge). Limits clamped.
 */
@RestController
public class DbCaptureLogsController {

    private final CallLogLinesUseCase lines;

    public DbCaptureLogsController(CallLogLinesUseCase lines) {
        this.lines = lines;
    }

    /**
     * {@code from}/{@code to} (ISO instants) and {@code minLevel} narrow to a moment and a level (specs/010 - the lines
     * around a failure); a bad value is a 400.
     */
    @GetMapping("/db-capture/outside/logs")
    public ResponseEntity<?> outside(@RequestParam(required = false) String project, @RequestParam(required = false) String thread,
                                     @RequestParam(defaultValue = "0") long after, @RequestParam(defaultValue = "200") int limit,
                                     @RequestParam(required = false) String from, @RequestParam(required = false) String to,
                                     @RequestParam(required = false) String minLevel) {
        try {
            if (from == null && to == null && minLevel == null) {
                return ResponseEntity.ok(lines.outside(project, thread, after, limit));
            }
            return ResponseEntity.ok(lines.outside(project, thread, after, limit, instant(from), instant(to), minLevel));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(java.util.Map.of("error", e.getMessage()));
        }
    }

    private static Long instant(String iso) {
        if (iso == null || iso.isBlank()) {
            return null;
        }
        try {
            return java.time.Instant.parse(iso.strip()).toEpochMilli();
        } catch (java.time.format.DateTimeParseException e) {
            throw new IllegalArgumentException("from/to must be ISO-8601 instants");
        }
    }
}
