package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.CallStoreSummary;

import java.util.Collection;
import java.util.List;
import java.util.Map;

/** Calls' store-command summaries - chips, the failures pill, endpoint health and cycle comparison (specs/011-redis-capture). */
public interface StoreSummariesUseCase {

    /** At most 100 ids per request (more is an IllegalArgumentException). */
    Map<String, CallStoreSummary> storeSummaries(Collection<String> callIds);

    /** Of up to 500 calls, those with a failed Redis command. */
    List<String> redisFailedCallIds(Collection<String> callIds);

    /** Totals over any number of calls (read in pages): commands, reads, hits, misses, failed calls, misses followed by the database. */
    Aggregate aggregate(Collection<String> callIds);

    record Aggregate(int calls, int callsWithRedis, long commands, long reads, long hits, long misses, int failedCalls, long micros,
                     long missToDb, Map<String, Long> byCommandAndPattern) {
    }
}
