package com.fathy.alfred.backend.database;

/** One storage file's row count and on-disk size - one entry per slice in the Database settings tab's file table. */
public record DatabaseFileStats(String name, long rows, long sizeBytes) {
}
