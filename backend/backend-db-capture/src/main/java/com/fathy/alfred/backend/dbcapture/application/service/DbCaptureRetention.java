package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.RetainedCallIdsPort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * The size cap (FR-039, research D9). Checked after a batch is stored - no timer - and only when the store has grown
 * past the cap does it ask which calls must be kept (those a session cycle holds; Relive-run statements are kept by the
 * store itself, by their run tag) and evict the oldest others. Outside-call statements are trimmed to 7 days and to a
 * fifth of the cap, so they can never crowd out calls.
 */
@Component
public class DbCaptureRetention implements IngestListener {

    private static final Logger log = LoggerFactory.getLogger(DbCaptureRetention.class);
    static final Duration OUTSIDE_MAX_AGE = Duration.ofDays(7);
    static final int EVICT_BATCH = 200;

    private final DbCaptureStorePort store;
    private final Optional<RetainedCallIdsPort> retained;
    private final Clock clock;
    private final long maxBytes;
    private long batchesSinceCheck;

    public DbCaptureRetention(DbCaptureStorePort store, Optional<RetainedCallIdsPort> retained, Optional<Clock> clock,
                              @Value("${ALFRED_DB_CAPTURE_MAX_SIZE_BYTES:4294967296}") long maxBytes) {
        this.store = store;
        this.retained = retained;
        this.clock = clock.orElse(Clock.systemUTC());
        this.maxBytes = maxBytes;
    }

    @Override
    public synchronized void batchIngested() {
        // The byte total is one indexed SUM; checking every 20 batches keeps it off the ingest hot path.
        if (++batchesSinceCheck < 20) {
            return;
        }
        batchesSinceCheck = 0;
        enforce();
    }

    synchronized void enforce() {
        store.trimOutside(clock.instant().minus(OUTSIDE_MAX_AGE).toString(), maxBytes / 5);
        if (store.totalBytes() <= maxBytes) {
            return;
        }
        Set<String> keep = retained.map(RetainedCallIdsPort::retainedCallIds).orElse(Set.of());
        int evicted = 0;
        while (store.totalBytes() > maxBytes) {
            List<String> oldest = store.oldestCallIds(EVICT_BATCH, keep);
            if (oldest.isEmpty()) {
                log.warn("db-capture.db is over its {} byte cap but every remaining call is held by a session or Relive cycle", maxBytes);
                return;
            }
            evicted += store.deleteForCalls(oldest);
        }
        log.info("db-capture.db size cap: evicted {} statements of the oldest calls", evicted);
    }
}
