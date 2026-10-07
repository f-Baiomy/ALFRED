package com.fathy.alfred.backend.dbcapture.domain.model;

/**
 * A call's store commands at a glance - the ⬢ chip, the "✖ Redis failures" pill, endpoint health (specs/011-redis-capture).
 * A row exists from the call's CALL_OPEN when the agent recorded its Redis commands ({@code commands} 0 = ⬢ was on, none
 * sent); no row = ⬢ was off. {@code live} until the call completed; {@code endedEarly} when it ended before capture did.
 */
public record CallStoreSummary(String callId, String project, int commands, int reads, int writes, int hits, int misses, int failed,
                               long micros, long dropped, boolean live, boolean endedEarly) {
}
