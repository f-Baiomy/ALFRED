package com.fathy.alfred.backend.server.application.port.in;

/** First start of a native install: create .env with every setting at its default (FR-011). */
public interface InitEnvUseCase {

    /** @return true when .env was created, false when one already existed (left untouched) */
    boolean initIfMissing();
}
