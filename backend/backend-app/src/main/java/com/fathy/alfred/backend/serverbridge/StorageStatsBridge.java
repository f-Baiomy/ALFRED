package com.fathy.alfred.backend.serverbridge;

import com.fathy.alfred.backend.calls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.StoreCommandsPort;
import com.fathy.alfred.backend.server.application.port.out.StorageStatsPort;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;

/**
 * Sizes and traffic for the server settings' storage checks (specs/012-server-program FR-030/032), from the same size
 * queries the Database tab uses. The inbound rate counts the retained ring buffer's calls of the last hour - that list
 * is already in memory (it is the one slice without a database), so this is a filter, not a scan of stored data.
 */
@Component
public class StorageStatsBridge implements StorageStatsPort {

    private final CallLogPort calls;
    private final com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort inbound;
    private final DbCaptureStorePort statements;
    private final Optional<StoreCommandsPort> redis;

    public StorageStatsBridge(CallLogPort calls, com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort inbound,
                              DbCaptureStorePort statements, Optional<StoreCommandsPort> redis) {
        this.calls = calls;
        this.inbound = inbound;
        this.statements = statements;
        this.redis = redis;
    }

    @Override
    public long usedBytes(String key) {
        return switch (key) {
            case "ALFRED_CALLS_MAX_SIZE_BYTES" -> calls.storageSizeBytes();
            case "ALFRED_DB_CAPTURE_MAX_SIZE_BYTES" -> statements.totalBytes();
            case "ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES" -> redis.map(StoreCommandsPort::bytes).orElse(-1L);
            default -> -1;
        };
    }

    @Override
    public long inboundCallsLastHour() {
        String since = Instant.now().minus(1, ChronoUnit.HOURS).toString();
        return inbound.readAll().stream().filter(c -> c.timestamp() != null && c.timestamp().compareTo(since) >= 0).count();
    }
}
