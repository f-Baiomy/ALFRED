package com.fathy.alfred.backend.calllogsbridge;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** `/call-logs`: a call's log lines, caught by the db-agent inside the application (specs/009-agent-log-capture). */
@RestController
public class CallLogsController {

    static final int MAX_COUNT_IDS = 100;

    private final CallLogsService service;

    public CallLogsController(CallLogsService service) {
        this.service = service;
    }

    @GetMapping("/call-logs/{callId}")
    public ResponseEntity<CallLogsModels.CallLogsPage> lines(@PathVariable String callId, @RequestParam(required = false) String cycleId,
                                                             @RequestParam(required = false) String after,
                                                             @RequestParam(defaultValue = "200") int limit) {
        return service.lines(callId, cycleId, after, limit).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** Counts for the calls the UI shows (at most {@value #MAX_COUNT_IDS} ids) - no line is read. */
    @GetMapping("/call-logs/counts")
    public Map<String, CallLogsModels.LogCounts> counts(@RequestParam(defaultValue = "") String callIds,
                                                        @RequestParam(required = false) String cycleId) {
        List<String> ids = Arrays.stream(callIds.split(",")).map(String::trim).filter(id -> !id.isEmpty()).distinct().toList();
        if (ids.size() > MAX_COUNT_IDS) {
            throw new IllegalArgumentException("at most " + MAX_COUNT_IDS + " call ids");
        }
        return service.counts(ids);
    }

    /** An imported call's lines (.json export's logLines), stored with the call. */
    @PostMapping("/call-logs/import")
    public Map<String, Integer> importLines(@Valid @RequestBody ImportDto body) {
        return Map.of("kept", service.importLines(body.callId(), body.lines()));
    }

    public record ImportDto(@NotBlank @Size(max = 200) String callId,
                            @NotNull @Size(max = 20_000) List<CallLogsModels.LinkedLogLine> lines) {
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, String>> invalid(IllegalArgumentException e) {
        return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
    }
}
