package com.fathy.alfred.backend.dbcapture.adapter.in.web;

import com.fathy.alfred.backend.dbcapture.adapter.in.web.dto.AgentSettingsResponse;
import com.fathy.alfred.backend.dbcapture.adapter.in.web.dto.BatchRequestDto;
import com.fathy.alfred.backend.dbcapture.adapter.in.web.dto.HeartbeatRequestDto;
import com.fathy.alfred.backend.dbcapture.application.port.in.IngestStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.RecordAgentHeartbeatUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestResult;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Where the db-agent inside the user's application sends what it captured (contracts/agent-ingest.md). Protected by
 * the same {@code alfred.webhook.secret} the proxies' webhooks use - the agent reads it from .env through
 * {@code secretFile}, never from a command line. The gateway publishes this on the one host port, so the check is
 * what stops anyone else posting statements.
 */
@RestController
public class DbCaptureAgentController {

    /** Larger than any honest batch (2,000 statements, rows streamed in 500-row chunks). */
    static final long MAX_BATCH_BYTES = 32L * 1024 * 1024;

    private final IngestStatementsUseCase ingestStatementsUseCase;
    private final RecordAgentHeartbeatUseCase recordAgentHeartbeatUseCase;

    @Value("${alfred.webhook.secret:}")
    private String webhookSecret;

    public DbCaptureAgentController(IngestStatementsUseCase ingestStatementsUseCase, RecordAgentHeartbeatUseCase recordAgentHeartbeatUseCase) {
        this.ingestStatementsUseCase = ingestStatementsUseCase;
        this.recordAgentHeartbeatUseCase = recordAgentHeartbeatUseCase;
    }

    @PostMapping("/db-capture/agent/batch")
    public ResponseEntity<IngestResult> batch(
            @RequestHeader(name = "X-Webhook-Secret", required = false) String providedSecret,
            HttpServletRequest request,
            @Valid @RequestBody BatchRequestDto body
    ) {
        if (!secretMatches(providedSecret)) {
            return ResponseEntity.status(401).build();
        }
        if (request.getContentLengthLong() > MAX_BATCH_BYTES) {
            return ResponseEntity.status(413).build();
        }
        return ResponseEntity.accepted().body(ingestStatementsUseCase.ingest(body.toDomain()));
    }

    @PostMapping("/db-capture/agent/heartbeat")
    public ResponseEntity<AgentSettingsResponse> heartbeat(
            @RequestHeader(name = "X-Webhook-Secret", required = false) String providedSecret,
            @Valid @RequestBody HeartbeatRequestDto body
    ) {
        if (!secretMatches(providedSecret)) {
            return ResponseEntity.status(401).build();
        }
        return ResponseEntity.ok(AgentSettingsResponse.of(recordAgentHeartbeatUseCase.heartbeat(body.toDomain())));
    }

    /** Constant-time, and an unset secret on this side accepts nothing - unlike an unset proxy secret, an agent is
     *  outside Docker and reaches this through the published gateway port. */
    private boolean secretMatches(String provided) {
        if (webhookSecret == null || webhookSecret.isBlank() || provided == null) {
            return false;
        }
        return MessageDigest.isEqual(webhookSecret.getBytes(StandardCharsets.UTF_8), provided.getBytes(StandardCharsets.UTF_8));
    }
}
