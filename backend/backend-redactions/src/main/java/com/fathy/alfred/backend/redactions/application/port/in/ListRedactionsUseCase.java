package com.fathy.alfred.backend.redactions.application.port.in;

import com.fathy.alfred.backend.redactions.domain.model.Redaction;

import java.util.List;

public interface ListRedactionsUseCase {

    List<Redaction> listAll();

    /**
     * Everything that applies when exporting this one call: its own CALL-scoped redactions plus
     * every ALL-scoped one, since an ALL redaction applies to every call by definition.
     */
    List<Redaction> listForCallId(String callId);
}
