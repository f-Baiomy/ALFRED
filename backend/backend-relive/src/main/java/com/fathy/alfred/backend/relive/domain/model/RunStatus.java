package com.fathy.alfred.backend.relive.domain.model;

/** See data-model.md "Run state transitions". */
public enum RunStatus {
    RUNNING,
    COMPLETED,
    COMPLETED_WITH_DIFFERENCES,
    FAILED,
    STOPPED,
    INTERRUPTED
}
