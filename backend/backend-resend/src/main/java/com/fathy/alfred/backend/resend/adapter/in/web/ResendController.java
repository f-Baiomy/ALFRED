package com.fathy.alfred.backend.resend.adapter.in.web;

import com.fathy.alfred.backend.resend.adapter.in.web.dto.ResendRequestDto;
import com.fathy.alfred.backend.resend.application.port.in.ResendCallUseCase;
import com.fathy.alfred.backend.resend.domain.model.ResendEdits;
import com.fathy.alfred.backend.resend.domain.model.ResendRequest;
import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/resend")
public class ResendController {

    private final ResendCallUseCase resendCallUseCase;
    private final long maxBodyBytes;

    public ResendController(ResendCallUseCase resendCallUseCase,
                             @Value("${alfred.interception.max-answer-bytes:10485760}") long maxBodyBytes) {
        this.resendCallUseCase = resendCallUseCase;
        this.maxBodyBytes = maxBodyBytes;
    }

    @PostMapping
    public ResponseEntity<Object> resend(@Valid @RequestBody ResendRequestDto body) {
        List<String> problems = new ArrayList<>();
        ResendRequestDto.EditsDto edits = body.edits();
        if (edits != null) {
            if (edits.headers() != null) {
                for (Map.Entry<String, String> entry : edits.headers().entrySet()) {
                    String name = entry.getKey();
                    String value = entry.getValue();
                    if (name == null || name.isBlank() || name.contains("\r") || name.contains("\n") || name.contains(":")) {
                        problems.add("header name " + name + " is not valid");
                        continue;
                    }
                    if (value != null && value.length() > 8192) {
                        problems.add("header " + name + " is over 8 KB");
                    }
                }
            }
            if (edits.body() != null && edits.body().getBytes(StandardCharsets.UTF_8).length > maxBodyBytes) {
                problems.add("body is over " + maxBodyBytes + " bytes");
            }
        }
        if (!problems.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid-request", "problems", problems));
        }

        ResendEdits resendEdits = edits == null ? ResendEdits.NONE
                : new ResendEdits(edits.method(), edits.url(), edits.headers(), edits.body());
        boolean useCurrentSession = body.useCurrentSession() != null && body.useCurrentSession();
        ResendRequest request = new ResendRequest(body.direction(), body.callId(), body.cycleId(), resendEdits, useCurrentSession);

        ResendCallUseCase.ResendOutcome outcome = resendCallUseCase.resend(request);
        return switch (outcome) {
            case ResendCallUseCase.ResendOutcome.Done done -> ResponseEntity.ok(Map.of(
                    "newCallId", done.result().newCallId(),
                    "status", done.result().status(),
                    "durationMs", done.result().durationMs(),
                    "sessionValuesUsed", done.result().sessionValuesUsed().stream()
                            .map(use -> Map.of("name", use.name(), "fromCallId", use.fromCallId()))
                            .toList()
            ));
            case ResendCallUseCase.ResendOutcome.NotFound ignored ->
                    ResponseEntity.status(404).body(Map.of("error", "call-not-found"));
            case ResendCallUseCase.ResendOutcome.ReverseProxyNotRunning ignored ->
                    ResponseEntity.status(409).body(Map.of("error", "reverse-proxy-not-running"));
            case ResendCallUseCase.ResendOutcome.SendFailed sendFailed ->
                    ResponseEntity.status(502).body(Map.of("error", "send-failed", "message", sendFailed.message()));
        };
    }
}
