package com.fathy.alfred.backend.logs.domain.model;

/** Where an input's lines come from. PUSH and OPENSEARCH wait on the secrets decision (tasks.md C1) and are rejected until then. */
public enum InputKind {
    UPLOAD, SERVER_FILE, FOLLOW, PUSH, OPENSEARCH
}
