package com.fathy.alfred.backend.internalcalls.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.internalcalls.application.port.out.RetentionPort;
import com.fathy.alfred.backend.internalcalls.application.service.CallListSupport;
import com.fathy.alfred.backend.internalcalls.domain.model.CallBaseline;
import com.fathy.alfred.backend.internalcalls.domain.model.CallInterception;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallStatusBreakdown;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.RecentRequestHeaders;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;
import com.fathy.alfred.backend.internalcalls.domain.model.WsMessage;
import com.fathy.alfred.backend.internalcalls.domain.model.WsMessagesPage;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * Thin {@link CallLogPort} over {@link SqliteInternalCallsRepository}, plus the one-time move of internal-calls.log into
 * the database. The default store; {@code alfred.storage.internal-calls.type=file} selects InternalCallsFileLogAdapter.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.internal-calls", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteInternalCallLogAdapter implements CallLogPort, RetentionPort {

    private static final Logger log = LoggerFactory.getLogger(SqliteInternalCallLogAdapter.class);

    /** Calls per migration transaction - kept small so the write lock is never held long while new calls arrive. */
    private static final int MIGRATION_BATCH = 100;

    private final SqliteInternalCallsRepository repository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${INTERNAL_CALLS_FILE:/appdata/internal-calls.log}")
    private String legacyFile;

    public SqliteInternalCallLogAdapter(SqliteInternalCallsRepository repository) {
        this.repository = repository;
    }

    SqliteInternalCallsRepository repository() {
        return repository;
    }

    /**
     * Moves internal-calls.log into the database once (research R6), in the background: the backend answers - and
     * stores new calls - from the start. The first move on the owner's install (6,751 calls, 467 MB, Docker Desktop
     * bind mount) took 18-23 minutes, all of it with the backend not answering and the proxies giving up reports.
     */
    @PostConstruct
    void migrateInBackground() {
        if (!Files.exists(Path.of(legacyFile))) {
            return;
        }
        Thread mover = new Thread(this::migrateLegacyFileIfPresent, "internal-calls-migration");
        mover.setDaemon(true);
        mover.start();
    }

    /**
     * Only the calls the file store was serving are moved - its newest {@code retentionRows} lines (older lines were
     * only waiting for the next compaction) - minus the ones a Relive run delete tombstoned. The lines are located by
     * byte offset in one streaming pass, so the file is never held in memory; each is parsed and inserted oldest first
     * at a negative rowid fixed by its position, so moved calls sort before every new call and a move interrupted half
     * way, run again, puts each call back on its own row. Renaming the file to *.migrated marks the move done.
     */
    void migrateLegacyFileIfPresent() {
        Path path = Path.of(legacyFile);
        if (!Files.exists(path)) {
            return;
        }
        long started = System.nanoTime();
        Path journal = Path.of(legacyFile + ".relive-deleted");
        Set<String> deleted = new HashSet<>();
        int moved = 0;
        int skipped = 0;
        try {
            if (Files.exists(journal)) {
                for (String id : Files.readAllLines(journal, StandardCharsets.UTF_8)) {
                    if (!id.isBlank()) {
                        deleted.add(id.strip());
                    }
                }
            }
            int keep = Math.max(1, repository.retentionRows());
            List<CallRecord> batch = new ArrayList<>(MIGRATION_BATCH);
            List<long[]> spans = lastNonEmptyLines(path, keep);
            long rowid = -spans.size();
            long batchRowid = rowid;
            try (SeekableByteChannel channel = Files.newByteChannel(path, StandardOpenOption.READ)) {
                for (long[] span : spans) {
                    long lineRowid = rowid++;
                    ByteBuffer buffer = ByteBuffer.allocate((int) span[1]);
                    channel.position(span[0]);
                    while (buffer.hasRemaining() && channel.read(buffer) > 0) {
                        // read the whole line
                    }
                    CallRecord call;
                    try {
                        call = objectMapper.readValue(buffer.array(), CallRecord.class);
                    } catch (IOException e) {
                        skipped++;
                        continue;
                    }
                    if (call.id() == null) {
                        call = withId(call, UUID.randomUUID().toString());
                    } else if (deleted.contains(call.id())) {
                        continue;
                    }
                    if (batch.isEmpty()) {
                        batchRowid = lineRowid;
                    } else if (lineRowid != batchRowid + batch.size()) {
                        // a skipped line (malformed, deleted) breaks the run of rowids: write what is consecutive
                        repository.insertMigrated(batch, batchRowid);
                        moved += batch.size();
                        batch.clear();
                        batchRowid = lineRowid;
                    }
                    batch.add(call);
                    if (batch.size() == MIGRATION_BATCH) {
                        repository.insertMigrated(batch, batchRowid);
                        moved += batch.size();
                        batch.clear();
                    }
                }
            }
            repository.insertMigrated(batch, batchRowid);
            moved += batch.size();
        } catch (IOException | RuntimeException e) {
            log.error("Could not move {} into internal-calls.db (will retry on the next start): {}", path, e.getMessage());
            return;
        }
        rename(path);
        if (Files.exists(journal)) {
            rename(journal);
        }
        log.info("Migrated {} inbound call(s) ({} malformed line(s) skipped) from {} into internal-calls.db in {} ms",
                moved, skipped, path, (System.nanoTime() - started) / 1_000_000);
    }

    /** Byte offset and length of the last {@code keep} non-empty lines, oldest first - a few bytes per line held. */
    static List<long[]> lastNonEmptyLines(Path path, int keep) throws IOException {
        long[][] ring = new long[keep][];
        int cursor = 0;
        int filled = 0;
        try (InputStream in = Files.newInputStream(path)) {
            byte[] buf = new byte[1 << 16];
            long pos = 0;
            long lineStart = 0;
            boolean content = false;
            int prev = -1;
            int read;
            while ((read = in.read(buf)) != -1) {
                for (int i = 0; i < read; i++) {
                    int b = buf[i] & 0xff;
                    long at = pos + i;
                    if (b == '\n') {
                        long end = prev == '\r' ? at - 1 : at;
                        if (content && end > lineStart) {
                            ring[cursor] = new long[] {lineStart, end - lineStart};
                            cursor = (cursor + 1) % keep;
                            filled = Math.min(keep, filled + 1);
                        }
                        lineStart = at + 1;
                        content = false;
                    } else if (b > ' ') {
                        content = true;
                    }
                    prev = b;
                }
                pos += read;
            }
            if (content && pos > lineStart) {
                long end = prev == '\r' ? pos - 1 : pos;
                ring[cursor] = new long[] {lineStart, end - lineStart};
                cursor = (cursor + 1) % keep;
                filled = Math.min(keep, filled + 1);
            }
        }
        List<long[]> spans = new ArrayList<>(filled);
        int start = filled < keep ? 0 : cursor;
        for (int i = 0; i < filled; i++) {
            spans.add(ring[(start + i) % keep]);
        }
        return spans;
    }

    private static void rename(Path file) {
        try {
            Files.move(file, file.resolveSibling(file.getFileName() + ".migrated"));
        } catch (IOException e) {
            log.warn("Moved the calls from {} but could not rename it to *.migrated: {}", file, e.getMessage());
        }
    }

    private static CallRecord withId(CallRecord c, String id) {
        return new CallRecord(id, c.originalUrl(), c.url(), c.method(), c.request(), c.timestamp(), c.durationMs(), c.response(),
                c.error(), c.state(), c.sessionId(), c.operationId(), c.serviceName(), c.interception(), c.resendOf(),
                c.resendEdits(), c.relive(), c.reachedUpstream());
    }

    // ------------------------------------------------------------------ CallLogPort / RetentionPort

    @Override
    public void prepare(CallRecord call) {
        repository.prepare(call);
    }

    @Override
    public boolean prepareOrMerge(CallRecord call) {
        return repository.prepare(call);
    }

    @Override
    public boolean complete(String id, ResponseData response, String error, Double durationMs,
                            CallInterception interception, Boolean reachedUpstream) {
        return repository.complete(id, response, error, durationMs, interception, reachedUpstream, null);
    }

    @Override
    public boolean complete(String id, ResponseData response, String error, Double durationMs,
                            CallInterception interception, Boolean reachedUpstream, CallRecord known) {
        return repository.complete(id, response, error, durationMs, interception, reachedUpstream, known);
    }

    @Override
    public CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit,
                                                    boolean paginationEnabled, String sessionId, String operationId,
                                                    String requestId, String serviceNames) {
        return repository.query(search, supplier, sort, offset, limit, paginationEnabled, sessionId, operationId, requestId,
                serviceNames, "");
    }

    @Override
    public CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit,
                                                    boolean paginationEnabled, String sessionId, String operationId,
                                                    String requestId, String serviceNames, String relive) {
        return repository.query(search, supplier, sort, offset, limit, paginationEnabled, sessionId, operationId, requestId,
                serviceNames, relive);
    }

    @Override
    public List<CallRecord> findByReliveRunId(String runId) {
        return repository.findByReliveRunId(runId);
    }

    @Override
    public List<CallRecord> findResolvedInRange(Instant from, Instant to, String search, String sessionId, String operationId,
                                                String requestId, String serviceNames) {
        return repository.findResolvedInRange(from, to, search, sessionId, operationId, requestId, serviceNames);
    }

    @Override
    public Optional<CallRecord> findById(String id) {
        return repository.findById(id);
    }

    @Override
    public long storageSizeBytes() {
        return repository.storageSizeBytes();
    }

    @Override
    public CallStatusBreakdown statusBreakdown() {
        return repository.statusBreakdown();
    }

    @Override
    public void deleteAll() {
        repository.deleteAll();
    }

    @Override
    public int deleteByReliveRunIds(java.util.Collection<String> runIds) {
        return repository.deleteByReliveRunIds(runIds);
    }

    /** Every call with its bodies - for the port contract only; no request path uses it (see the repository test). */
    @Override
    public List<CallRecord> readAll() {
        return repository.readAll();
    }

    @Override
    public CallBaseline baselineFor(String url) {
        return repository.baselineFor(url);
    }

    @Override
    public void appendWsMessages(String callId, List<WsMessage> messages, boolean closed, Integer closeCode) {
        repository.appendWsMessages(callId, messages);
    }

    @Override
    public WsMessagesPage wsMessages(String callId, int offset, int limit) {
        return repository.wsMessages(callId, offset, limit);
    }

    @Override
    public List<RecentRequestHeaders> recentRequestHeaders(String host, int limit) {
        return repository.recentRequestHeaders(host, Math.min(limit, MAX_RECENT_REQUEST_HEADERS));
    }

    @Override
    public void setRetentionRows(int rows) {
        repository.setRetentionRows(rows);
    }

    @Override
    public void setMaxSizeBytes(long bytes) {
        repository.setMaxSizeBytes(bytes);
    }

    @Override
    public int deleteByIds(java.util.Collection<String> callIds) {
        return repository.deleteByIds(callIds);
    }

    @Override
    public List<com.fathy.alfred.backend.internalcalls.domain.model.CleanupCandidate> cleanupCandidates(
            com.fathy.alfred.backend.internalcalls.domain.model.CleanupFilter filter, int limit) {
        return repository.cleanupCandidates(filter, limit);
    }

    @Override
    public java.util.Optional<String> oldestTimestamp() {
        return repository.oldestTimestamp();
    }
}
