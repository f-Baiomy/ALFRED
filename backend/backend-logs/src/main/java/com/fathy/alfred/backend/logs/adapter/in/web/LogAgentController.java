package com.fathy.alfred.backend.logs.adapter.in.web;

import com.fathy.alfred.backend.logs.application.port.in.LogsException;
import com.fathy.alfred.backend.logs.application.port.in.WatchFoldersUseCase;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;

/**
 * The host agent (log-agent/agent.py) on Docker Desktop: it receives the OS's change notifications for
 * the watched folders and reports them here; the backend then reads the new bytes from its own mount.
 * Only notifications cross - never file content. Guarded by a shared secret from .env
 * ({@code ALFRED_LOGS_AGENT_SECRET}); without one configured the endpoint is off (503).
 */
@RestController
@RequestMapping("/logs/agent")
public class LogAgentController {

    static final String HEADER = "X-Agent-Secret";

    public record Change(@NotNull @Size(max = 40) String folder, @NotNull @Size(max = 1024) String path) {
    }

    public record ChangesRequest(@NotNull @Size(max = 1000) List<@Valid Change> changes) {
    }

    private final WatchFoldersUseCase watch;

    @Value("${LOGS_AGENT_SECRET:}")
    private String secret;

    public LogAgentController(WatchFoldersUseCase watch) {
        this.watch = watch;
    }

    private void check(String given) {
        if (secret == null || secret.isBlank()) {
            throw new LogsException(LogsException.Kind.UNAVAILABLE, "The log agent is not configured (ALFRED_LOGS_AGENT_SECRET)");
        }
        // Constant-time comparison: the secret is never leaked through response timing.
        if (given == null || !MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8), secret.getBytes(StandardCharsets.UTF_8))) {
            throw new LogsException(LogsException.Kind.FORBIDDEN, "Wrong agent secret");
        }
    }

    /** The agent started or reconnected: everything is re-checked, so changes made while it was away are read. */
    @PostMapping("/hello")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void hello(@RequestHeader(value = HEADER, required = false) String given) {
        check(given);
        watch.agentSeen();
    }

    @PostMapping("/changes")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void changes(@RequestHeader(value = HEADER, required = false) String given, @Valid @RequestBody ChangesRequest body) {
        check(given);
        watch.agentSeen();
        for (Change c : body.changes()) {
            if ("*".equals(c.path())) {
                watch.rescan(c.folder());
            } else {
                watch.changed(c.folder(), c.path());
            }
        }
    }
}
