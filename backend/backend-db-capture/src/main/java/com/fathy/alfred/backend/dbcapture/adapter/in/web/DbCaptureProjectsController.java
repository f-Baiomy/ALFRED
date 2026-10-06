package com.fathy.alfred.backend.dbcapture.adapter.in.web;

import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.InboundLoggingOffException;
import com.fathy.alfred.backend.dbcapture.domain.model.ProjectCaptureStatus;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/** The capture switch and settings per project - the Sources bar, the cycle widget and Settings all call these. */
@RestController
public class DbCaptureProjectsController {

    private final ManageDbCaptureUseCase manage;

    public DbCaptureProjectsController(ManageDbCaptureUseCase manage) {
        this.manage = manage;
    }

    @GetMapping("/db-capture/projects")
    public List<ProjectCaptureStatus> projects() {
        return manage.projects();
    }

    @PutMapping("/db-capture/projects/{project}/enabled")
    public List<ProjectCaptureStatus> setEnabled(@PathVariable String project, @RequestBody EnabledDto body) {
        return manage.setEnabled(project, body != null && body.enabled());
    }

    /** The ▤ Logs switch (specs/008-logs-call-link) - 409 while the project's inbound logging is off, like ◆. */
    @PutMapping("/db-capture/projects/{project}/logs")
    public List<ProjectCaptureStatus> setLogsOn(@PathVariable String project, @RequestBody LogsOnDto body) {
        return manage.setLogsOn(project, body != null && body.on());
    }

    @GetMapping("/db-capture/projects/{project}/settings")
    public DbCaptureSettings settings(@PathVariable String project) {
        return manage.settings(project);
    }

    @PutMapping("/db-capture/projects/{project}/settings")
    public DbCaptureSettings saveSettings(@PathVariable String project, @RequestBody DbCaptureSettings settings) {
        return manage.saveSettings(project, settings);
    }

    @PostMapping("/db-capture/projects/{project}/expected")
    public DbCaptureSettings markExpected(@PathVariable String project, @RequestBody ExpectedDto body) {
        return manage.markExpected(project, body == null ? null : body.fingerprint());
    }

    @ExceptionHandler(InboundLoggingOffException.class)
    public ResponseEntity<Map<String, String>> inboundOff(InboundLoggingOffException e) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", e.getMessage()));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, String>> invalid(IllegalArgumentException e) {
        return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
    }

    public record EnabledDto(boolean enabled) {
    }

    public record ExpectedDto(String fingerprint) {
    }

    public record LogsOnDto(boolean on) {
    }
}
