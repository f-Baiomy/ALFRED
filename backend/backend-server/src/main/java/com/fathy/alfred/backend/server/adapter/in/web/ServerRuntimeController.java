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

    public ServerRuntimeController(ServerRuntimeUseCase runtime, @Value("${alfred.webhook.secret:}") String webhookSecret) {
        this.runtime = runtime;
        this.webhookSecret = webhookSecret;
    }

    public record RestartRequest(@NotNull ServerRuntimeUseCase.Target what) {
    }

    public record SupervisorEvent(@NotNull @Size(max = 32) @Pattern(regexp = "[A-Z_]+") String name,
                                  @Size(max = 32) String state) {
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

    @PostMapping("/supervisor-events")
    public ResponseEntity<Void> supervisorEvent(@RequestHeader(value = "X-Webhook-Secret", required = false) String secret,
                                                @Valid @RequestBody SupervisorEvent event) {
        if (webhookSecret.isEmpty() || secret == null
                || !MessageDigest.isEqual(webhookSecret.getBytes(StandardCharsets.UTF_8), secret.getBytes(StandardCharsets.UTF_8))) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        runtime.processChanged(event.name());
        return ResponseEntity.noContent().build();
    }
}
