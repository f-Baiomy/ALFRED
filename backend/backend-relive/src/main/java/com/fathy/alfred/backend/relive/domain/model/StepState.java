package com.fathy.alfred.backend.relive.domain.model;

/** See data-model.md "Step state transitions". */
public enum StepState {
    PENDING,
    WAITING,
    PAUSED,
    RUNNING,
    REPLAYED,
    LIVE,
    INTERCEPTED,
    COMPLETED,
    COMPLETED_WITH_DIFFERENCES,
    FAILED,
    SKIPPED,
    NOT_CALLED,
    CANCELLED
}
