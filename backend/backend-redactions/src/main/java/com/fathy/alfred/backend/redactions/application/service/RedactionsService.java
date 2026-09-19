package com.fathy.alfred.backend.redactions.application.service;

import com.fathy.alfred.backend.redactions.application.port.in.CreateRedactionUseCase;
import com.fathy.alfred.backend.redactions.application.port.in.DeleteRedactionUseCase;
import com.fathy.alfred.backend.redactions.application.port.in.ListRedactionsUseCase;
import com.fathy.alfred.backend.redactions.application.port.out.RedactionsStorePort;
import com.fathy.alfred.backend.redactions.domain.model.NewRedaction;
import com.fathy.alfred.backend.redactions.domain.model.Redaction;
import com.fathy.alfred.backend.redactions.domain.model.RedactionScope;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.stream.Collectors;

@Service
public class RedactionsService implements ListRedactionsUseCase, CreateRedactionUseCase, DeleteRedactionUseCase {

    private final RedactionsStorePort store;

    public RedactionsService(RedactionsStorePort store) {
        this.store = store;
    }

    @Override
    public List<Redaction> listAll() {
        return store.findAll();
    }

    @Override
    public List<Redaction> listForCallId(String callId) {
        return store.findAll().stream()
                .filter(r -> r.scope() == RedactionScope.ALL
                        || (r.scope() == RedactionScope.CALL && callId.equals(r.callId())))
                .collect(Collectors.toList());
    }

    @Override
    public Redaction create(NewRedaction newRedaction) {
        // An ALL-scoped redaction is not tied to a call, so any callId that slipped through is
        // normalised away here rather than persisted as dead data.
        String callId = newRedaction.scope() == RedactionScope.ALL ? null : newRedaction.callId();
        Redaction redaction = new Redaction(
                java.util.UUID.randomUUID().toString(),
                newRedaction.scope(),
                callId,
                newRedaction.kind(),
                newRedaction.name(),
                Instant.now().toString()
        );
        return store.save(redaction);
    }

    @Override
    public boolean deleteById(String id) {
        return store.deleteById(id);
    }
}
