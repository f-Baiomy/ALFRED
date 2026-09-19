package com.fathy.alfred.backend.redactions.adapter.in.web;

import com.fathy.alfred.backend.redactions.adapter.in.web.dto.RedactionRequestDto;
import com.fathy.alfred.backend.redactions.application.port.in.CreateRedactionUseCase;
import com.fathy.alfred.backend.redactions.application.port.in.DeleteRedactionUseCase;
import com.fathy.alfred.backend.redactions.application.port.in.ListRedactionsUseCase;
import com.fathy.alfred.backend.redactions.domain.model.NewRedaction;
import com.fathy.alfred.backend.redactions.domain.model.Redaction;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/redactions")
public class RedactionsController {

    private final ListRedactionsUseCase listRedactionsUseCase;
    private final CreateRedactionUseCase createRedactionUseCase;
    private final DeleteRedactionUseCase deleteRedactionUseCase;

    public RedactionsController(
            ListRedactionsUseCase listRedactionsUseCase,
            CreateRedactionUseCase createRedactionUseCase,
            DeleteRedactionUseCase deleteRedactionUseCase
    ) {
        this.listRedactionsUseCase = listRedactionsUseCase;
        this.createRedactionUseCase = createRedactionUseCase;
        this.deleteRedactionUseCase = deleteRedactionUseCase;
    }

    /**
     * Without {@code callId}, every redaction. With one, everything that applies when exporting
     * that call - its own CALL-scoped marks plus all ALL-scoped ones.
     */
    @GetMapping
    public List<Redaction> list(@RequestParam(required = false) String callId) {
        return (callId == null || callId.isBlank())
                ? listRedactionsUseCase.listAll()
                : listRedactionsUseCase.listForCallId(callId);
    }

    @PostMapping
    public Redaction create(@Valid @RequestBody RedactionRequestDto request) {
        NewRedaction newRedaction = new NewRedaction(
                request.scope(),
                request.callId(),
                request.kind(),
                request.name()
        );
        return createRedactionUseCase.create(newRedaction);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        boolean deleted = deleteRedactionUseCase.deleteById(id);
        return deleted ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}
