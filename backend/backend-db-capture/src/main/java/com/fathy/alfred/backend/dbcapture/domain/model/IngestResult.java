package com.fathy.alfred.backend.dbcapture.domain.model;

/** How many statements of a batch were new, and how many the store already had (a retried batch). */
public record IngestResult(int accepted, int duplicates) {
}
