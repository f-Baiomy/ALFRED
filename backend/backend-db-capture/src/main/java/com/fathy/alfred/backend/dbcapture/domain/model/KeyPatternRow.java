package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/** One row of the Keys view (specs/011-redis-capture FR-022): a key pattern's commands, hits and misses, time, last writer. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record KeyPatternRow(String pattern, int commands, int reads, int writes, int hits, int misses, int failed, long micros,
                            String lastWriter) {
}
