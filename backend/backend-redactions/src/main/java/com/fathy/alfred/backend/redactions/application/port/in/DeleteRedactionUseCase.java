package com.fathy.alfred.backend.redactions.application.port.in;

public interface DeleteRedactionUseCase {

    /** @return true if a redaction with this id existed and was deleted. */
    boolean deleteById(String id);
}
