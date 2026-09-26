package com.fathy.alfred.backend.resend.adapter.in.web;

import com.fathy.alfred.backend.resend.adapter.in.web.dto.ResendBatchDto;
import com.fathy.alfred.backend.resend.adapter.in.web.dto.ResendEditsDto;
import com.fathy.alfred.backend.resend.adapter.in.web.dto.ResendRequestDto;
import com.fathy.alfred.backend.resend.application.port.in.ResendCallUseCase;
import com.fathy.alfred.backend.resend.application.port.in.ResendCallUseCase.ResendOutcome;
import com.fathy.alfred.backend.resend.domain.model.ResendBatch;
import com.fathy.alfred.backend.resend.domain.model.ResendEdits;
import com.fathy.alfred.backend.resend.domain.model.ResendRequest;
import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** POST /resend - resends a logged call through Alfred's own proxies. See contracts/rest-api.md. */
@RestController
public class ResendController {

    private static final int MAX_HEADER_ENTRIES = 100;
    private static final int MAX_HEADER_VALUE_BYTES = 8 * 1024;
    private static final int MAX_BATCH_ID_LENGTH = 64;
    private static final int MAX_BATCH_TOTAL = 1000;

    private final ResendCallUseCase resendCallUseCase;
    private final long maxBodyBytes;

    public ResendController(ResendCallUseCase resendCallUseCase,
                             @Value("${alfred.interception.max-answer-bytes}") long maxBodyBytes) {
        this.resendCallUseCase = resendCallUseCase;
        this.maxBodyBytes = maxBodyBytes;
    }

    @PostMapping("/resend")
    public ResponseEntity<Object> resend(@Valid @RequestBody ResendRequestDto body) {
        List<String> problems = limitProblems(body.edits());
        problems.addAll(batchProblems(body.batch()));
        if (!problems.isEmpty()) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of("error", "invalid-request", "problems", problems));
        }

        ResendRequest request = new ResendRequest(body.direction(), body.callId(), blankToNull(body.cycleId()),
                toDomain(body.edits()), body.useCurrentSession(), toDomain(body.batch()));
        ResendOutcome outcome = resendCallUseCase.resend(request);
        return switch (outcome) {
            case ResendOutcome.Success success -> ResponseEntity.ok(success.result());
            case ResendOutcome.NotFound notFound -> ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("error", "call-not-found"));
            case ResendOutcome.ReverseProxyNotRunning notRunning -> ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(Map.of("error", "reverse-proxy-not-running"));
            case ResendOutcome.SendFailed failed -> ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body(Map.of("error", "send-failed", "message", String.valueOf(failed.message())));
        };
    }

    private List<String> limitProblems(ResendEditsDto edits) {
        List<String> problems = new ArrayList<>();
        if (edits == null) {
            return problems;
        }
        if (edits.headers() != null) {
            if (edits.headers().size() > MAX_HEADER_ENTRIES) {
                problems.add("edits.headers may have at most " + MAX_HEADER_ENTRIES + " entries.");
            }
            edits.headers().forEach((name, value) -> {
                if (value != null && value.getBytes(StandardCharsets.UTF_8).length > MAX_HEADER_VALUE_BYTES) {
                    problems.add("edits.headers." + name + " must be " + MAX_HEADER_VALUE_BYTES + " bytes or fewer.");
                }
            });
        }
        if (edits.body() != null && edits.body().getBytes(StandardCharsets.UTF_8).length > maxBodyBytes) {
            problems.add("edits.body must be " + maxBodyBytes + " bytes or fewer.");
        }
        return problems;
    }

    private static List<String> batchProblems(ResendBatchDto batch) {
        List<String> problems = new ArrayList<>();
        if (batch == null) {
            return problems;
        }
        if (batch.id() == null || batch.id().isBlank()) {
            problems.add("batch.id must not be blank.");
        } else if (batch.id().length() > MAX_BATCH_ID_LENGTH) {
            problems.add("batch.id must be " + MAX_BATCH_ID_LENGTH + " characters or fewer.");
        }
        if (batch.index() == null || batch.total() == null) {
            problems.add("batch.index and batch.total are required.");
        } else if (batch.index() < 1 || batch.index() > batch.total() || batch.total() > MAX_BATCH_TOTAL) {
            problems.add("batch must satisfy 1 <= index <= total <= " + MAX_BATCH_TOTAL + ".");
        }
        return problems;
    }

    private static ResendBatch toDomain(ResendBatchDto dto) {
        return dto == null ? null : new ResendBatch(dto.id(), dto.index(), dto.total());
    }

    private static ResendEdits toDomain(ResendEditsDto dto) {
        return dto == null ? null : new ResendEdits(dto.method(), dto.url(), dto.headers(), dto.body());
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
