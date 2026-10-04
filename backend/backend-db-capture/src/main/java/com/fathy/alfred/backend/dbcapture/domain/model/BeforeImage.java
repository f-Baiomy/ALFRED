package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * Where an UPDATE/DELETE's "before" rows come from (research D12): an earlier read of the same rows in the same
 * call ({@code EARLIER_READ}, {@code earlierSeq} points at it), a read the agent made just before the change because
 * before-image is on for the table ({@code AGENT_READ}, rows stored under this statement), or nothing
 * ({@code NONE}, optionally with the reason the agent could not do it).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record BeforeImage(String source, Integer earlierSeq, Long extraReadMicros, String skippedReason, Integer rowCount,
                          List<Column> columns) {

    public static final String EARLIER_READ = "EARLIER_READ";
    public static final String AGENT_READ = "AGENT_READ";
    public static final String NONE = "NONE";
}
