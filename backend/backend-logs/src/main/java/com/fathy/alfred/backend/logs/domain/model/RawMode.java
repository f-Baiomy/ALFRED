package com.fathy.alfred.backend.logs.domain.model;

/** COPY keeps every raw line in logs.db; OFFSET keeps only (input, byte offset) and reads the original file on demand (FR-005). */
public enum RawMode {
    COPY, OFFSET
}
