package com.fathy.alfred.backend.calllogsbridge;

import com.fathy.alfred.backend.logs.application.port.in.KeptLogLinesUseCase;
import com.fathy.alfred.backend.logs.application.port.in.LogsException;
import com.fathy.alfred.backend.logs.application.port.in.ManageProjectLogsUseCase.ProjectLogsView;
import com.fathy.alfred.backend.logs.domain.model.ProjectLogSettings;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** `/call-logs` (specs/008-logs-call-link/contracts/call-logs-api.md) - a new gateway prefix. */
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

    /** The call a Logs-tab line was written during; 204 when none. */
    @GetMapping("/call-logs/for-line")
    public ResponseEntity<CallLogsModels.LineCall> forLine(@RequestParam String sourceId, @RequestParam String lineId) {
        return service.forLine(sourceId, lineId).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    /** Counts for the calls the UI shows (at most {@value #MAX_COUNT_IDS} ids) - no line is read in full. */
    @GetMapping("/call-logs/counts")
    public Map<String, CallLogsModels.LogCounts> counts(@RequestParam(defaultValue = "") String callIds,
                                                        @RequestParam(required = false) String cycleId) {
        List<String> ids = Arrays.stream(callIds.split(",")).map(String::trim).filter(id -> !id.isEmpty()).distinct().toList();
        if (ids.size() > MAX_COUNT_IDS) {
            throw new IllegalArgumentException("at most " + MAX_COUNT_IDS + " call ids");
        }
        return service.counts(ids, cycleId);
    }

    /** An imported call's lines (.json export's logLines), kept as Alfred's own copies (FR-016). */
    @PostMapping("/call-logs/import")
    public Map<String, Integer> importLines(@Valid @RequestBody ImportDto body) {
        return Map.of("kept", service.importLines(body.callId(), body.lines()));
    }

    public record ImportDto(@NotBlank @Size(max = 200) String callId,
                            @NotNull @Size(max = KeptLogLinesUseCase.MAX_KEPT_PER_CALL) List<CallLogsModels.LinkedLogLine> lines) {
    }

    @GetMapping("/call-logs/settings/{project}")
    public ProjectLogsView settings(@PathVariable String project) {
        return service.settings(project);
    }

    @PutMapping("/call-logs/settings/{project}")
    public ProjectLogsView saveSettings(@PathVariable String project, @Valid @RequestBody SettingsDto body) {
        return service.saveSettings(new ProjectLogSettings(project, body.sourceIds(), body.threadField(), body.timeField(), body.callIdField(),
                body.clockSkewMs() == null ? ProjectLogSettings.DEFAULT_CLOCK_SKEW_MS : body.clockSkewMs()));
    }

    public record SettingsDto(
            @Size(max = ProjectLogSettings.MAX_SOURCES) List<@Size(max = 64) String> sourceIds,
            @Size(max = 300) String threadField,
            @Size(max = 300) String timeField,
            @Size(max = 300) String callIdField,
            @Min(0) @Max(ProjectLogSettings.MAX_CLOCK_SKEW_MS) Integer clockSkewMs
    ) {
    }

    @ExceptionHandler(LogsException.class)
    public ResponseEntity<Map<String, String>> logs(LogsException e) {
        HttpStatus status = switch (e.kind()) {
            case NOT_FOUND -> HttpStatus.NOT_FOUND;
            case CONFLICT -> HttpStatus.CONFLICT;
            default -> HttpStatus.BAD_REQUEST;
        };
        return ResponseEntity.status(status).body(Map.of("error", e.getMessage()));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, String>> invalid(IllegalArgumentException e) {
        return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
    }
}
