package com.fathy.alfred.backend.logs.domain.model;

/**
 * Where an input's lines come from. PUSH and OPENSEARCH wait on the secrets decision (tasks.md C1) and are
 * rejected until then. WATCH is a watched folder (one of {@code logs_watch_dirs}); it owns one WATCHED_FILE
 * child per matching file, each followed live on change notifications (no timer).
 */
public enum InputKind {
    UPLOAD, SERVER_FILE, FOLLOW, PUSH, OPENSEARCH, WATCH, WATCHED_FILE
}
