package com.fathy.alfred.backend.board.domain.model;

/**
 * board.db on disk: the file (with its WAL), what the data uses, and the free space deleted cycles and cards left - SQLite
 * reuses it but never gives it back until the file is compacted (VACUUM). Plus counts of what the board holds.
 */
public record BoardStorage(long fileBytes, long usedBytes, long freeBytes, long cards, long comments, long specFiles, long briefs,
                           long cardsOfDeletedCycles) {
}
