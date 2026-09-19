package com.fathy.alfred.backend.redactions.application.port.out;

import com.fathy.alfred.backend.redactions.domain.model.Redaction;

import java.util.List;

/** Outbound port: redaction persistence, without the application core knowing whether it's a flat JSON file or SQLite today. */
public interface RedactionsStorePort {

    List<Redaction> findAll();

    Redaction save(Redaction redaction);

    /** @return true if a redaction with this id existed and was deleted. */
    boolean deleteById(String id);

    /** Full overwrite - present for parity with the comments slice's store (one-time migrations/maintenance), not used by any request path. */
    void replaceAll(List<Redaction> redactions);

    /** Bytes currently occupied on disk by this adapter's storage - drives the Database settings tab's file-size table. */
    long storageSizeBytes();
}
