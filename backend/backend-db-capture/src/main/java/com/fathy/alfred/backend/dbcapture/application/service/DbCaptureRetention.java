package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.in.SetCaptureBudgetUseCase;
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
public class DbCaptureRetention implements IngestListener, SetCaptureBudgetUseCase {

    private static final Logger log = LoggerFactory.getLogger(DbCaptureRetention.class);
    static final Duration OUTSIDE_MAX_AGE = Duration.ofDays(7);
    static final int EVICT_BATCH = 200;

    private final DbCaptureStorePort store;
    private final Optional<RetainedCallIdsPort> retained;
    private final Clock clock;
    private volatile long maxBytes;
    private long batchesSinceCheck;
    /** Redis commands' own budget (specs/011-redis-capture FR-036, clarification Q2): 2 GB, oldest calls' commands out whole. */
    static final Duration INCOMPLETE_MAX_AGE = Duration.ofMinutes(10);
    private Optional<com.fathy.alfred.backend.dbcapture.application.port.out.StoreCommandsPort> storeCommands = Optional.empty();
    private volatile long maxRedisBytes = 2_147_483_648L;

    public DbCaptureRetention(DbCaptureStorePort store, Optional<RetainedCallIdsPort> retained, Optional<Clock> clock,
                              @Value("${ALFRED_DB_CAPTURE_MAX_SIZE_BYTES:4294967296}") long maxBytes) {
        this.store = store;
        this.retained = retained;
        this.clock = clock.orElse(Clock.systemUTC());
        this.maxBytes = maxBytes;
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setStoreCommands(com.fathy.alfred.backend.dbcapture.application.port.out.StoreCommandsPort storeCommands,
                          @Value("${ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES:2147483648}") long maxRedisBytes) {
        this.storeCommands = Optional.ofNullable(storeCommands);
        this.maxRedisBytes = maxRedisBytes;
    }

    /** A LIVE setting (specs/012-server-program): the next size check (after at most 20 batches) uses it. */
    @Override
    public void setStatementsMaxBytes(long bytes) {
        if (bytes < 1) {
            throw new IllegalArgumentException("the size cap must be positive");
        }
        this.maxBytes = bytes;
    }

    @Override
    public void setRedisMaxBytes(long bytes) {
        if (bytes < 1) {
            throw new IllegalArgumentException("the size cap must be positive");
        }
        this.maxRedisBytes = bytes;
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
        storeCommands.ifPresent(this::enforceRedis);
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

    /**
     * Redis commands kept under their own cap: parts that never completed go after 10 minutes; then, while over the cap,
     * the oldest calls lose all their commands together - never part of them, never a call a cycle holds, never a value
     * shortened.
     */
    void enforceRedis(com.fathy.alfred.backend.dbcapture.application.port.out.StoreCommandsPort commands) {
        commands.purgeIncomplete(clock.instant().minus(INCOMPLETE_MAX_AGE).toEpochMilli());
        if (commands.bytes() <= maxRedisBytes) {
            return;
        }
        Set<String> keep = retained.map(RetainedCallIdsPort::retainedCallIds).orElse(Set.of());
        int evicted = 0;
        while (commands.bytes() > maxRedisBytes) {
            List<String> oldest = commands.oldestCallIds(EVICT_BATCH, keep);
            if (oldest.isEmpty()) {
                log.warn("Redis commands are over their {} byte cap but every remaining call is held by a session or Relive cycle", maxRedisBytes);
                return;
            }
            evicted += commands.deleteForCalls(oldest);
        }
        log.info("Redis size cap: removed {} commands of the oldest calls", evicted);
    }
}
