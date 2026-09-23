package com.fathy.alfred.backend.interception.adapter.in.web;

import com.fathy.alfred.backend.interception.adapter.in.web.dto.CopyAnswerRequestDto;
import com.fathy.alfred.backend.interception.adapter.in.web.dto.StoredAnswerDto;
import com.fathy.alfred.backend.interception.application.port.in.ManageStoredAnswersUseCase;
import com.fathy.alfred.backend.interception.application.port.in.ManageStoredAnswersUseCase.CopyResult;
import jakarta.validation.Valid;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/** Stored answers: the responses a rule can answer with. See contracts/rest-api.md. */
@RestController
@RequestMapping("/interception/answers")
public class StoredAnswersController {

    private final ManageStoredAnswersUseCase answers;

    public StoredAnswersController(ManageStoredAnswersUseCase answers) {
        this.answers = answers;
    }

    @PostMapping("/from-call")
    public ResponseEntity<Object> copyFromCall(@Valid @RequestBody CopyAnswerRequestDto body) {
        CopyResult result = answers.copyFromCall(body.direction(), body.callId(), blankToNull(body.cycleId()),
                body.keepSecrets());
        return switch (result) {
            case CopyResult.Created created ->
                    ResponseEntity.status(HttpStatus.CREATED).body(StoredAnswerDto.of(created.answer(), List.of()));
            case CopyResult.SecretsDecisionRequired decision -> ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(Map.of("error", "secrets-decision-required", "secretNames", decision.secretNames()));
            case CopyResult.NotFound notFound -> ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("error", "call-not-found"));
            case CopyResult.TooLarge tooLarge -> ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE)
                    .body(Map.of("error", "answer-too-large", "limitBytes", tooLarge.limitBytes(),
                            "sizeBytes", tooLarge.sizeBytes()));
        };
    }

    @GetMapping("/{id}")
    public ResponseEntity<StoredAnswerDto> get(@PathVariable String id) {
        return answers.get(id).map(StoredAnswerDto::of).map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * The raw bytes, for the editor's preview. Served as an attachment, sniff-proof and sandboxed:
     * a recorded body can be any HTML a supplier returned, and it must never run as a page on
     * Alfred's own origin just because somebody opened this URL.
     */
    @GetMapping("/{id}/body")
    public ResponseEntity<byte[]> body(@PathVariable String id) {
        return answers.get(id).flatMap(view -> answers.body(id).map(bytes -> ResponseEntity.ok()
                        .contentType(mediaType(view.answer().contentType()))
                        .header(HttpHeaders.CONTENT_DISPOSITION, "attachment")
                        .header("X-Content-Type-Options", "nosniff")
                        .header("Content-Security-Policy", "sandbox")
                        .body(bytes)))
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    private static MediaType mediaType(String contentType) {
        try {
            return contentType == null ? MediaType.APPLICATION_OCTET_STREAM : MediaType.parseMediaType(contentType);
        } catch (RuntimeException e) {
            return MediaType.APPLICATION_OCTET_STREAM;
        }
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
