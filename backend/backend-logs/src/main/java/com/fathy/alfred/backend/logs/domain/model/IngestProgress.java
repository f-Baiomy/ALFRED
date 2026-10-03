package com.fathy.alfred.backend.logs.domain.model;

/** Pushed over /ws/logs after every batch; never carries line content. */
public record IngestProgress(String sourceId, String inputId, InputStatus status, String reason,
                             long lines, long bytes, long totalBytes, long unparsed, long mismatch,
                             String newField) {
}
