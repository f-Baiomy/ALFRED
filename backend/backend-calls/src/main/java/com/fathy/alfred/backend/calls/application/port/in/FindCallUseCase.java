package com.fathy.alfred.backend.calls.application.port.in;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;

import java.util.Optional;

/** A single logged call by id, full record (not just its detail projection) - one indexed lookup, not a list scan. */
public interface FindCallUseCase {
    Optional<CallRecord> find(String id);
}
