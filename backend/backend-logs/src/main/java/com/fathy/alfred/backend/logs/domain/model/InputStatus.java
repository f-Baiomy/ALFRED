package com.fathy.alfred.backend.logs.domain.model;

/** Lifecycle of an input (data-model.md). WAITING = followed file currently missing. */
public enum InputStatus {
    QUEUED, UPLOADING, LOADING, DONE, FOLLOWING, WAITING, PAUSED, FAILED
}
