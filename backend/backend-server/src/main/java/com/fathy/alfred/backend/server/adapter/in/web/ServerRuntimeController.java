package com.fathy.alfred.backend.server.adapter.in.web;

import com.fathy.alfred.backend.server.application.port.in.ServerRuntimeUseCase;
import com.fathy.alfred.backend.server.domain.model.ServerStatus;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * The Server card (US4): status, restarts, and the supervisor's state reports. A restart is a write - the access rule
 * applies ({@link EditAccessInterceptor}). The supervisor's reports carry the webhook secret instead, like the
 * proxies' webhooks (Constitution I).
 */
@RestController
@RequestMapping("/server")
public class ServerRuntimeController {

    private final ServerRuntimeUseCase runtime;
    private final String webhookSecret;
    private final org.springframework.context.ApplicationEventPublisher publisher;

    public ServerRuntimeController(ServerRuntimeUseCase runtime, @Value("${alfred.webhook.secret:}") String webhookSecret,
                                   org.springframework.context.ApplicationEventPublisher publisher) {
        this.runtime = runtime;
        this.webhookSecret = webhookSecret;
        this.publisher = publisher;
    }

    public record RestartRequest(@NotNull ServerRuntimeUseCase.Target what) {
    }

    /**
     * What the supervisor reports: a child's state ({@code name} is the process), {@code UPDATE}, {@code AGENTS}, or
     * {@code APP} - a project's application appeared on / left its upstream port ({@code project}, {@code port},
     * {@code pid}, {@code state} LISTENING or GONE).
     */
    public record SupervisorEvent(@NotNull @Size(max = 32) @Pattern(regexp = "[A-Z_]+") String name,
                                  @Size(max = 32) String state,
                                  @Size(max = 100) @Pattern(regexp = "[A-Za-z0-9._-]*") String project,
                                  Integer port, Long pid) {
    }

    @GetMapping("/status")
    public ServerStatus status() {
        return runtime.status();
    }

    @PostMapping("/restart")
    public ResponseEntity<Map<String, Object>> restart(@Valid @RequestBody RestartRequest body) {
        runtime.restart(body.what());
        return ResponseEntity.accepted().body(Map.of("accepted", true));
    }

    /** The Settings switch or the auto-attach bridge asking for the agent; the supervisor does the finding and loading. */
    public record AttachRequest(@NotNull @Size(max = 100) @Pattern(regexp = "[A-Za-z0-9._-]+") String project,
                                @Size(max = 4) List<@Pattern(regexp = "proxy|db|logs|redis") String> features, boolean force) {
    }

    @PostMapping("/agents/attach")
    public ResponseEntity<Map<String, Object>> attachAgent(@Valid @RequestBody AttachRequest body) {
        List<String> features = body.features() == null || body.features().isEmpty() ? List.of("db", "logs", "redis") : body.features();
        boolean accepted = runtime.attachAgent(body.project(), features, body.force());
        if (!accepted) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("accepted", false,
                    "message", "Nothing here can attach the agent: natively the supervisor ('alfred start'), with Docker the agent host that start.py/restart.py start on the machine - or attach with 'alfred attach' or -javaagent."));
        }
        return ResponseEntity.accepted().body(Map.of("accepted", true));
    }

    @PostMapping("/supervisor-events")
    public ResponseEntity<Void> supervisorEvent(@RequestHeader(value = "X-Webhook-Secret", required = false) String secret,
                                                @Valid @RequestBody SupervisorEvent event) {
        if (webhookSecret.isEmpty() || secret == null
                || !MessageDigest.isEqual(webhookSecret.getBytes(StandardCharsets.UTF_8), secret.getBytes(StandardCharsets.UTF_8))) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if ("APP".equals(event.name()) && event.project() != null && !event.project().isBlank()) {
            publisher.publishEvent(new ServerRuntimeUseCase.AppSeen(event.project(), event.port() == null ? 0 : event.port(),
                    event.pid() == null ? 0 : event.pid(), "LISTENING".equals(event.state())));
        }
        runtime.processChanged(event.name());
        return ResponseEntity.noContent().build();
    }
}
