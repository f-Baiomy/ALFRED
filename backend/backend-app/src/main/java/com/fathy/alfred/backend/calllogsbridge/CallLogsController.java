package com.fathy.alfred.backend.calllogsbridge;

import com.fathy.alfred.backend.logs.application.port.in.LogsException;
import com.fathy.alfred.backend.logs.application.port.in.ManageProjectLogsUseCase.ProjectLogsView;
import com.fathy.alfred.backend.logs.domain.model.ProjectLogSettings;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/** `/call-logs` (specs/008-logs-call-link/contracts/call-logs-api.md) - a new gateway prefix. */
@RestController
public class CallLogsController {

    private final CallLogsService service;

    public CallLogsController(CallLogsService service) {
        this.service = service;
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
