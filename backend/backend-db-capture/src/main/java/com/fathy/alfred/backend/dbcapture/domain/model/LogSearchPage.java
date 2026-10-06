package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * One page of a log search, newest first. {@code total} is exact for a text search; a pattern search that hit its time
 * or candidate bound says so in {@code cutShort} and counts only what it examined.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record LogSearchPage(long total, List<CaughtLogLine> lines, Long nextBeforeId, CutShort cutShort) {

    /** @param reason TIME or CANDIDATES */
    public record CutShort(long scannedLines, String reason) {
    }
}
