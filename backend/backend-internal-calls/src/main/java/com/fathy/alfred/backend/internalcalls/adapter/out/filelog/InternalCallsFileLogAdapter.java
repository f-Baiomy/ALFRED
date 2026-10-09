package com.fathy.alfred.backend.internalcalls.adapter.out.filelog;

import com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.internalcalls.application.port.out.RetentionPort;
import com.fathy.alfred.backend.internalcalls.application.service.CallListSupport;
import com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.internalcalls.domain.model.CallBaseline;
import com.fathy.alfred.backend.internalcalls.domain.model.ReliveFilter;
import com.fathy.alfred.backend.internalcalls.domain.model.CallInterception;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallStatusBreakdown;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Owns internal-calls.log end to end - the only place in this slice that knows calls live in a
 * flat file. Unlike backend-calls, this slice has only ever had one storage adapter (no
 * SQLite/file switch) - until specs/013-inbound-calls-store, which made SqliteInternalCallLogAdapter the default.
 * This store is now the opt-out ({@code alfred.storage.internal-calls.type=file}), still fully working: its retained
 * window lives in memory, which is why the database became the default (835 MB live at 7,000 calls).
 *
 * <p>Mirrors FileCallLogAdapter's exact caching idiom: reads are served from an in-memory cache
 * rather than re-parsing the file on every request, validated against the file's size and
 * last-modified-time on every read so a file modified or replaced out-of-band is re-read rather
 * than silently ignored. Per-instance, never static.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.internal-calls", name = "type", havingValue = "file")
public class InternalCallsFileLogAdapter implements CallLogPort, RetentionPort {

    private static final Logger log = LoggerFactory.getLogger(InternalCallsFileLogAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${INTERNAL_CALLS_FILE:/appdata/internal-calls.log}")
    private String internalCallsFile;

    /**
     * How many calls the ring buffer keeps - this slice's only retention mechanism.
     *
     * <p>Deliberately NOT {@code alfred.internal-calls.max-limit}, which is the largest page GET
     * /internal-calls will serve. One property used to do both jobs, which meant the live inbound
     * list could never hold more calls than a single page: raising retention raised the page size
     * and vice versa, and inbound traffic silently evicted calls that were still recent. Confirmed
     * live - a call logged 90 minutes earlier had already been pushed out by newer traffic while
     * the list still claimed to be showing everything.
     *
     * <p>A new call costs one appended line, not a rewrite of the whole file (see {@link #save}),
     * so this no longer scales the per-call write cost - only how much the periodic compaction has
     * to stream, and how much of the file a cold read parses. Raising it into five figures still
     * wants a real store rather than a bigger flat file, but for a different reason now: read and
     * filter cost, not write amplification.
     */
    @Value("${alfred.internal-calls.retention-rows:1500}")
    private volatile int retentionRows;

    /**
     * How many lines the file is actually allowed to hold before {@link #save} compacts it back
     * down to {@link #retentionRows}. The slack is what makes appending viable: without it, every
     * call past the cap would have to rewrite the file to drop one old line, which is exactly the
     * behaviour this replaced.
     *
     * <p>Half the retention (floored at 50 for very small caps) amortises one rewrite over that
     * many calls - at the default 1500 that is one compaction per 750 calls instead of one rewrite
     * per call. The cost is that the file can sit up to 50% larger than the cap on disk; reads are
     * unaffected, since {@link #loadLines} only ever serves the newest {@code retentionRows}.
     */
    private int compactionThreshold() {
        return retentionRows + Math.max(retentionRows / 2, 50);
    }

    /**
     * Changes the cap while running (specs/012-server-program, a LIVE setting). Taken under the same lock as
     * {@link #save}, so it never lands between a save's read and its write; the next save trims the cached view and
     * the next compaction trims the file.
     */
    @Override
    public synchronized void setRetentionRows(int rows) {
        if (rows < 1) {
            throw new IllegalArgumentException("retention must be at least 1 row");
        }
        this.retentionRows = rows;
    }

    /**
     * Lines currently on disk, which is NOT {@code cachedLines.size()} - between compactions the
     * file legitimately holds more than {@link #retentionRows} while the cache serves only the
     * newest ones. -1 when unknown (nothing read yet, or the cache was invalidated); every write
     * path calls {@link #loadLines} first, so it is always populated by the time it is read.
     */
    private int linesOnDisk = -1;

    /** Per-call cap on retained WebSocket messages - mirrors backend-calls' own property. */
    @Value("${alfred.internal-calls.ws-max-messages:1000}")
    private int wsMaxMessages;

    /**
     * WebSocket messages, kept in memory only - never written to internal-calls.log or a sibling
     * file. Consistent with this slice's own design, not a shortcut: it has no SQLite adapter and
     * already keeps its whole retained window resident in memory (see docs/architecture.md on why
     * backend's mem_limit is 2g), so messages for calls the ring still retains living in memory
     * too costs nothing this slice doesn't already pay. Pruned in {@link #save} whenever the ring
     * evicts a call, so this map's size stays bounded by retentionRows * wsMaxMessages the same
     * way the ring itself is bounded.
     */
    private final Map<String, List<com.fathy.alfred.backend.internalcalls.domain.model.WsMessage>> wsMessagesByCallId =
            new ConcurrentHashMap<>();
    private final Map<String, Integer> wsDroppedByCallId = new ConcurrentHashMap<>();

    private void pruneWsMessages(List<CachedLine> retained) {
        if (wsMessagesByCallId.isEmpty()) {
            return;
        }
        var retainedIds = retained.stream().map(line -> line.record() != null ? line.record().id() : null)
                .filter(java.util.Objects::nonNull)
                .collect(java.util.stream.Collectors.toSet());
        wsMessagesByCallId.keySet().removeIf(id -> !retainedIds.contains(id));
        wsDroppedByCallId.keySet().removeIf(id -> !retainedIds.contains(id));
    }

    /**
     * A retained call. {@code record} is null when the line did not parse; that line still occupies
     * a slot in the ring, and {@link #readAll()} keeps skipping it.
     *
     * <p>The raw line is deliberately not kept here. It is a second copy of the same request and
     * response bodies the record already holds, and with {@code retention-rows} in the thousands
     * that copy alone filled the heap — a later read of any other multi-megabyte column then failed
     * with OutOfMemoryError. Compaction copies the retained line bytes from the file instead.
     */
    private record CachedLine(CallRecord record) {}

    /** Null until the first read/write populates it. Replaced wholesale, never mutated in place. */
    private List<CachedLine> cachedLines;
    private long cachedFileSize = -1;
    private long cachedModifiedMillis = -1;

    /**
     * Holds a {@link #prepare}d call here in memory until {@link #complete} merges in the outcome
     * and only then writes it to disk exactly once. If the process restarts between prepare and
     * complete, the pending entry is lost and complete() degrades to persisting whatever the
     * completion payload alone can produce (no request-side data) - the same accepted gap
     * backend-calls' FileCallLogAdapter takes for the same scenario.
     */
    private final Map<String, CallRecord> pendingById = new ConcurrentHashMap<>();

    /** Fail fast with a clear message if the directory isn't writable, rather than only discovering it on the first webhook call. */
    @PostConstruct
    void checkStorageIsWritable() {
        Path path = Path.of(internalCallsFile);
        Path parent = path.getParent();
        if (parent == null) {
            return;
        }
        try {
            Files.createDirectories(parent);
            if (!Files.isWritable(parent)) {
                log.error("Internal-calls directory {} is not writable - saving new calls will fail", parent);
            }
        } catch (IOException e) {
            log.error("Could not create internal-calls directory {}: {}", parent, e.getMessage());
        }
    }

    @Override
    public synchronized List<CallRecord> readAll() {
        List<CachedLine> lines = loadLines();
        List<CallRecord> calls = new ArrayList<>(lines.size());
        for (CachedLine line : lines) {
            if (line.record() != null) {
                calls.add(line.record());
            }
        }
        return Collections.unmodifiableList(calls);
    }

    /**
     * internal-calls.log is a ring buffer, not an unbounded append log: reads only ever see the
     * newest {@link #retentionRows} calls. Synchronized so concurrent webhook calls can't
     * interleave their read-modify-write and lose an entry.
     *
     * <p><strong>Appends one line; rewrites the file only on compaction.</strong> This used to
     * rebuild the entire file in memory on every single call - {@code StringBuilder} over every
     * retained line, then {@code toString()}, then encode to bytes - which at the default 1500-row
     * cap and a real ~33 KB call is on the order of 150-250 MB of transient allocation to record
     * ONE call, against a 256 MB heap. Under concurrent inbound traffic the backend OOMed and
     * dropped calls silently: the proxy delivered every webhook (no client-side failure to log),
     * the handler threw {@code OutOfMemoryError}, and the call was simply never persisted.
     * Measured on this adapter before the change: 60 concurrent inbound calls produced 504
     * {@code OutOfMemoryError}s and only 4 of the 60 were stored.
     *
     * <p>Appending costs one call's own bytes regardless of how big the file is, so the per-call
     * cost is now flat instead of growing with the retention cap.
     */
    private synchronized void save(CallRecord call) {
        Path path = Path.of(internalCallsFile);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }

            List<CachedLine> retained = loadLines();
            String addedText = objectMapper.writeValueAsString(call);
            CachedLine added = new CachedLine(call);

            // The cache always holds the retained VIEW (newest retentionRows), even while the file
            // on disk legitimately holds more - that gap is what the slack buys.
            List<CachedLine> next = new ArrayList<>(retained.size() + 1);
            next.addAll(retained);
            next.add(added);
            if (next.size() > retentionRows) {
                next = new ArrayList<>(next.subList(next.size() - retentionRows, next.size()));
                pruneWsMessages(next);
            }

            if (linesOnDisk + 1 > compactionThreshold()) {
                // Every entry but the one just added is already the file's newest lines.
                linesOnDisk = writeCompacted(path, next.size() - 1, addedText);
            } else {
                Files.writeString(path, addedText + System.lineSeparator(),
                        StandardOpenOption.CREATE, StandardOpenOption.APPEND, StandardOpenOption.WRITE);
                linesOnDisk++;
            }

            rememberCache(path, next);
        } catch (IOException e) {
            invalidateCache();
            log.error("Failed to save to {}: {}", internalCallsFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    /**
     * Replaces {@code path} with its newest {@code linesFromFile} non-empty lines, byte for byte,
     * then appends {@code newCallJson} when it is non-null. Returns how many lines the file has
     * afterwards.
     *
     * <p>Only the line offsets are held (a few bytes each). The line bodies stay on disk and are
     * copied through a small buffer, so compaction does not pull the retained window into the heap
     * a second time. A crash mid-write leaves the previous file intact.
     */
    private int writeCompacted(Path path, int linesFromFile, String newCallJson) throws IOException {
        boolean tombstones = !reliveDeletedCallIds.isEmpty();
        List<LineSpan> spans = tombstones
                // Tombstoned lines leave the file here: keep the newest live lines, not the newest
                // lines - the retained window counts only calls that are still visible.
                ? withoutTombstoned(path, lastNonEmptySpans(path, linesFromFile + reliveDeletedCallIds.size()), linesFromFile)
                : lastNonEmptySpans(path, linesFromFile);
        Path temp = path.resolveSibling(path.getFileName() + ".compacting");
        byte[] newline = System.lineSeparator().getBytes(StandardCharsets.UTF_8);
        try (SeekableByteChannel src = Files.newByteChannel(path, StandardOpenOption.READ);
             OutputStream out = Files.newOutputStream(temp, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
            byte[] buf = new byte[8192];
            for (LineSpan span : spans) {
                src.position(span.start());
                long left = span.length();
                while (left > 0) {
                    int n = src.read(ByteBuffer.wrap(buf, 0, (int) Math.min(buf.length, left)));
                    if (n < 0) {
                        break;
                    }
                    out.write(buf, 0, n);
                    left -= n;
                }
                out.write(newline);
            }
            if (newCallJson != null) {
                out.write(newCallJson.getBytes(StandardCharsets.UTF_8));
                out.write(newline);
            }
        }
        moveIntoPlace(temp, path);
        if (tombstones) {
            // Every tombstoned call is gone from the file now - dropped above, or older than what
            // was kept - so the journal has nothing left to hide (it used to grow forever).
            reliveDeletedCallIds.clear();
            try {
                Files.deleteIfExists(deletedJournal());
            } catch (IOException e) {
                log.warn("Could not remove the relive deleted-ids journal: {}", e.getMessage());
            }
        }
        return spans.size() + (newCallJson == null ? 0 : 1);
    }

    /** The newest {@code keep} of {@code spans} whose call is not tombstoned. Only lines that
     *  mention a relive attribution are parsed. */
    private List<LineSpan> withoutTombstoned(Path path, List<LineSpan> spans, int keep) throws IOException {
        List<LineSpan> live = new ArrayList<>(spans.size());
        byte[] needle = "\"relive\":{".getBytes(StandardCharsets.UTF_8);
        try (SeekableByteChannel src = Files.newByteChannel(path, StandardOpenOption.READ)) {
            for (LineSpan span : spans) {
                ByteBuffer buffer = ByteBuffer.allocate(span.length());
                src.position(span.start());
                while (buffer.hasRemaining() && src.read(buffer) > 0) {
                    // read the whole line
                }
                byte[] bytes = buffer.array();
                if (indexOf(bytes, bytes.length, new Needle(needle)) >= 0) {
                    try {
                        com.fasterxml.jackson.databind.JsonNode node = objectMapper.readTree(bytes);
                        if (node.hasNonNull("id") && reliveDeletedCallIds.contains(node.get("id").asText())) {
                            continue;
                        }
                    } catch (IOException e) {
                        // Unparseable: kept, exactly like every other read path keeps it.
                    }
                }
                live.add(span);
            }
        }
        return live.size() <= keep ? live : live.subList(live.size() - keep, live.size());
    }

    /** Byte range of one line's content, excluding its terminator. */
    private record LineSpan(long start, int length) {}

    /**
     * Offsets of the last {@code keep} non-empty lines, oldest first. A line is empty when it has
     * no byte above ASCII space, which is the log-file equivalent of {@code String.strip().isEmpty()}.
     * The terminator ({@code \n} or {@code \r\n}) is not part of the range, matching {@code readLine}.
     */
    private static List<LineSpan> lastNonEmptySpans(Path path, int keep) throws IOException {
        if (keep <= 0 || !Files.exists(path)) {
            return List.of();
        }
        LineSpan[] ring = new LineSpan[keep];
        int cursor = 0;
        int filled = 0;
        try (InputStream in = Files.newInputStream(path)) {
            byte[] buf = new byte[8192];
            long pos = 0;
            long lineStart = 0;
            boolean nonWhitespace = false;
            int prev = -1;
            int read;
            while ((read = in.read(buf)) != -1) {
                for (int i = 0; i < read; i++) {
                    int b = buf[i] & 0xff;
                    long at = pos + i;
                    if (b == '\n') {
                        long end = prev == '\r' ? at - 1 : at;
                        if (nonWhitespace && end > lineStart) {
                            ring[cursor] = new LineSpan(lineStart, (int) (end - lineStart));
                            cursor = (cursor + 1) % keep;
                            if (filled < keep) {
                                filled++;
                            }
                        }
                        lineStart = at + 1;
                        nonWhitespace = false;
                    } else if (b != '\r' && b > ' ') {
                        nonWhitespace = true;
                    }
                    prev = b;
                }
                pos += read;
            }
            if (lineStart < pos) {
                long end = prev == '\r' ? pos - 1 : pos;
                if (nonWhitespace && end > lineStart) {
                    ring[cursor] = new LineSpan(lineStart, (int) (end - lineStart));
                    cursor = (cursor + 1) % keep;
                    if (filled < keep) {
                        filled++;
                    }
                }
            }
        }
        List<LineSpan> spans = new ArrayList<>(filled);
        int start = filled < keep ? 0 : cursor;
        for (int i = 0; i < filled; i++) {
            spans.add(ring[(start + i) % keep]);
        }
        return spans;
    }

    private static void moveIntoPlace(Path temp, Path path) throws IOException {
        try {
            Files.move(temp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(temp, path, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /**
     * Calls completed recently (newest last, bounded): a completion seen here again, or a prepare arriving for one of
     * them, is a repeat of a report already stored - never a new call.
     *
     * <p>The proxy sends prepare, then complete, one after the other, and retries a report that failed (timeout,
     * 5xx). Two things follow. A prepare that timed out on the proxy side may still reach the backend - after its
     * completion: complete found nothing pending and stored the call from the completion alone, and the late prepare
     * used to sit in {@link #pendingById} forever, waiting for a completion that had already happened. And a retried
     * report may repeat one the backend already stored: a second complete used to append a second line for the same
     * call. A late prepare now fills the request into the stored line when it is still missing; any other repeat is
     * acknowledged without writing.
     */
    private final Map<String, Boolean> recentlyCompleted = Collections.synchronizedMap(new java.util.LinkedHashMap<>() {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
            return size() > 1000;
        }
    });

    /** Holds the partial call in memory only - nothing is written to internal-calls.log until {@link #complete} - see the class-level doc on {@link #pendingById}. */
    @Override
    public void prepare(CallRecord call) {
        prepareOrMerge(call);
    }

    /**
     * Not synchronized, like prepare always was (a prepare must not wait for another call's disk write). Each side
     * writes its own mark before reading the other's - this one {@link #pendingById}, {@link #complete}
     * {@link #recentlyCompleted} - so at least one of them sees the other, and the atomic remove from
     * pendingById decides which one carries on.
     */
    @Override
    public boolean prepareOrMerge(CallRecord call) {
        pendingById.put(call.id(), call);
        if (recentlyCompleted.containsKey(call.id()) && pendingById.remove(call.id(), call)) {
            mergeLatePrepare(call);
            return true;
        }
        return false;
    }

    @Override
    public boolean complete(String id, ResponseData response, String error, Double durationMs,
                            CallInterception interception, Boolean reachedUpstream) {
        return complete(id, response, error, durationMs, interception, reachedUpstream, null);
    }

    /**
     * Merges the outcome into the pending call (if this process is still the one that prepared it) and performs the
     * one, single-shot disk write. Without a pending call, {@code known} (the call as the proxy saw it, sent with the
     * completion) still says which call this was.
     */
    @Override
    public synchronized boolean complete(String id, ResponseData response, String error, Double durationMs,
                                         CallInterception interception, Boolean reachedUpstream, CallRecord known) {
        loadDeletedJournal();
        if (reliveDeletedCallIds.contains(id)) {
            // The call was deleted by a relive history delete while it was still in flight - its
            // completion must not resurrect it on disk.
            pendingById.remove(id);
            return false;
        }
        boolean repeat = recentlyCompleted.put(id, Boolean.TRUE) != null;
        CallRecord partial = pendingById.remove(id);
        if (partial == null && repeat) {
            // A retried completion of a call already stored (its first attempt reached us, the answer did not reach the
            // proxy): acknowledged, not written twice.
            return true;
        }
        boolean wasPending = partial != null;
        boolean hasError = error != null && !error.isBlank();
        CallLifecycleStatus state = hasError ? CallLifecycleStatus.ERROR : CallLifecycleStatus.COMPLETED;
        CallRecord resolved = partial != null
                // Uses the full 13-arg constructor (unlike backend-calls' FileCallLogAdapter,
                // which drops sessionId/operationId here via its 10-arg constructor - harmless
                // there since SQLite is that slice's primary adapter, but this file adapter is
                // this slice's *only* store, so losing session/operation id (or now serviceName)
                // at completion time would silently break the session-id/operation-id/source
                // filters for every completed call). relive is known at prepare time (research
                // D2.3), so it comes from partial, not this completion payload.
                ? new CallRecord(partial.id(), partial.originalUrl(), partial.url(), partial.method(), partial.request(),
                        partial.timestamp(), durationMs, response, error, state, partial.sessionId(), partial.operationId(), partial.serviceName(),
                        null, partial.resendOf(), partial.resendEdits(), partial.relive(), reachedUpstream)
                // Degraded fallback: this process never saw the matching prepare() (restarted in between, or the
                // prepare is late - see recentlyCompleted). The proxy's own view of the call names it; only
                // the request headers and body are missing (a late prepare fills them in). relive unknown here.
                : known != null
                ? new CallRecord(id, known.originalUrl(), known.url(), known.method(), null, known.timestamp(), durationMs,
                        response, error, state, known.sessionId(), known.operationId(), known.serviceName(),
                        null, null, null, null, reachedUpstream)
                : new CallRecord(id, null, null, null, null, null, durationMs, response, error, state, null, null, null,
                        null, null, null, null, reachedUpstream);
        save(resolved.withInterception(interception));
        return wasPending;
    }

    /**
     * A prepare that arrived after its completion: its request side goes into the stored row - the line is replaced
     * in place, streamed through a temp file like compaction (rare: only after a prepare timeout). False when the
     * row is gone (trimmed, deleted).
     */
    private synchronized boolean mergeLatePrepare(CallRecord prepared) {
        List<CachedLine> lines = loadLines();
        int at = -1;
        for (int i = lines.size() - 1; i >= 0; i--) {
            CallRecord r = lines.get(i).record();
            if (r != null && prepared.id().equals(r.id())) {
                at = i;
                break;
            }
        }
        if (at < 0) {
            return false;
        }
        CallRecord stored = lines.get(at).record();
        if (stored.request() != null) {
            return false; // a repeat of a prepare already in the line - nothing to add
        }
        CallRecord merged = new CallRecord(stored.id(), prepared.originalUrl(), prepared.url(), prepared.method(), prepared.request(),
                prepared.timestamp(), stored.durationMs(), stored.response(), stored.error(), stored.state(),
                prepared.sessionId(), prepared.operationId(), prepared.serviceName(), stored.interception(),
                prepared.resendOf(), prepared.resendEdits(), prepared.relive(), stored.reachedUpstream());
        Path path = Path.of(internalCallsFile);
        try {
            replaceLine(path, stored.id(), objectMapper.writeValueAsString(merged));
        } catch (IOException e) {
            invalidateCache();
            log.error("Failed to merge a late prepare into {}: {}", internalCallsFile, e.getMessage());
            return false;
        }
        List<CachedLine> next = new ArrayList<>(cachedLines != null ? cachedLines : lines);
        for (int i = next.size() - 1; i >= 0; i--) {
            CallRecord r = next.get(i).record();
            if (r != null && stored.id().equals(r.id())) {
                next.set(i, new CachedLine(merged));
                break;
            }
        }
        rememberCache(path, next);
        return true;
    }

    /**
     * Copies the file through a temp file, one line at a time, with the last line of call {@code id} replaced by
     * {@code json}. Every line is written with its id first, so only each line's head is looked at.
     */
    private void replaceLine(Path path, String id, String json) throws IOException {
        String marker = "{\"id\":\"" + id + "\"";
        int target = -1;
        int index = 0;
        try (BufferedReader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            String rawLine;
            while ((rawLine = reader.readLine()) != null) {
                if (rawLine.isBlank()) {
                    continue;
                }
                if (rawLine.strip().startsWith(marker)) {
                    target = index;
                }
                index++;
            }
        }
        if (target < 0) {
            throw new IOException("no line for call " + id);
        }
        Path temp = path.resolveSibling(path.getFileName() + ".compacting");
        try (BufferedReader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8);
             BufferedWriter writer = Files.newBufferedWriter(temp, StandardCharsets.UTF_8,
                     StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
            String rawLine;
            index = 0;
            while ((rawLine = reader.readLine()) != null) {
                if (rawLine.isBlank()) {
                    continue;
                }
                writer.write(index == target ? json : rawLine);
                writer.newLine();
                index++;
            }
        }
        moveIntoPlace(temp, path);
    }

    /** Returns the cached lines minus any tombstoned by the relive history delete, re-reading and
     *  re-parsing only when the file's size/mtime no longer match what was cached. */
    private List<CachedLine> loadLines() {
        loadDeletedJournal();
        Path path = Path.of(internalCallsFile);
        if (!Files.exists(path)) {
            cachedLines = List.of();
            cachedFileSize = -1;
            cachedModifiedMillis = -1;
            linesOnDisk = 0;
            return cachedLines;
        }

        BasicFileAttributes attributes = readAttributes(path);
        if (cachedLines != null && attributes != null
                && attributes.size() == cachedFileSize
                && attributes.lastModifiedTime().toMillis() == cachedModifiedMillis) {
            return filterDeleted(cachedLines);
        }

        Scan scan;
        try {
            scan = scanFile(path);
            if (scan.needsBackfill()) {
                rewriteMissingIds(path);
                scan = scanFile(path);
            }
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to read " + path, e);
        }
        // Every non-empty line the file holds, not just the retained view - this is what decides
        // when the next save has to compact.
        linesOnDisk = scan.lineCount();
        rememberCache(path, scan.retained());
        return filterDeleted(cachedLines != null ? cachedLines : List.copyOf(scan.retained()));
    }

    /** Tombstoned relive calls may still be on disk until the retention ring evicts them - they
     *  just never surface through any read. The cache itself stays unfiltered so the file's
     *  size/mtime stay the only invalidation inputs. */
    private List<CachedLine> filterDeleted(List<CachedLine> lines) {
        if (reliveDeletedCallIds.isEmpty()) {
            return lines;
        }
        List<CachedLine> kept = new ArrayList<>(lines.size());
        for (CachedLine line : lines) {
            if (line.record() == null || !reliveDeletedCallIds.contains(line.record().id())) {
                kept.add(line);
            }
        }
        return kept;
    }

    private record Scan(int lineCount, boolean needsBackfill, List<CachedLine> retained) {}

    /**
     * One pass over the file. The ring keeps only the newest {@link #retentionRows} parsed lines,
     * and each of those drops the raw JSON as soon as it has been parsed, so a cold read of a
     * file that is larger than the heap never has to hold both copies at once.
     */
    private Scan scanFile(Path path) throws IOException {
        ArrayDeque<CachedLine> ring = new ArrayDeque<>();
        int count = 0;
        boolean needsBackfill = false;
        try (BufferedReader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            String rawLine;
            while ((rawLine = reader.readLine()) != null) {
                String trimmed = rawLine.strip();
                if (trimmed.isEmpty()) {
                    continue;
                }
                count++;
                CallRecord record = null;
                try {
                    record = objectMapper.readValue(trimmed, CallRecord.class);
                    if (record.id() == null) {
                        needsBackfill = true;
                    }
                } catch (IOException e) {
                    log.warn("Skipping malformed line in {}: {}", path, e.getMessage());
                }
                ring.addLast(new CachedLine(record));
                while (ring.size() > retentionRows) {
                    ring.removeFirst();
                }
            }
        }
        return new Scan(count, needsBackfill, new ArrayList<>(ring));
    }

    /**
     * Rewrites the whole file so every line that parsed without an id gets one, one line at a time.
     * Lines that already have an id are copied back unchanged. Same durability as compaction: a
     * temp file is moved into place only after the rewrite finishes.
     */
    private void rewriteMissingIds(Path path) throws IOException {
        Path temp = path.resolveSibling(path.getFileName() + ".compacting");
        try (BufferedReader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8);
             BufferedWriter writer = Files.newBufferedWriter(temp, StandardCharsets.UTF_8,
                     StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
            String rawLine;
            while ((rawLine = reader.readLine()) != null) {
                String trimmed = rawLine.strip();
                if (trimmed.isEmpty()) {
                    continue;
                }
                String written = rawLine;
                try {
                    CallRecord record = objectMapper.readValue(trimmed, CallRecord.class);
                    if (record.id() == null) {
                        written = objectMapper.writeValueAsString(withGeneratedId(record));
                    }
                } catch (IOException e) {
                    log.warn("Skipping malformed line in {}: {}", path, e.getMessage());
                }
                writer.write(written);
                writer.newLine();
            }
        }
        moveIntoPlace(temp, path);
    }

    /**
     * Filters/sorts/paginates over the full in-memory list, applying the sessionId/operationId/
     * requestId substring filters and the serviceNames exact-match filter first, since
     * CallListSupport here has no built-in id-filter overload (only backend-calls' SQL repository
     * has that) - then maps to CallSummary as the final step, matching CallLogPort's summary-only
     * contract.
     */
    @Override
    public CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled,
                                                     String sessionId, String operationId, String requestId, String serviceNames) {
        return query(search, supplier, sort, offset, limit, paginationEnabled, sessionId, operationId, requestId, serviceNames, "");
    }

    @Override
    public CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled,
                                                     String sessionId, String operationId, String requestId, String serviceNames, String relive) {
        java.util.Set<String> serviceNameFilter = parseServiceNames(serviceNames);
        List<CallRecord> idFiltered = readAll().stream()
                .filter(call -> ReliveFilter.matches(call.relive(), relive))
                .filter(call -> matchesSubstring(call.sessionId(), sessionId))
                .filter(call -> matchesSubstring(call.operationId(), operationId))
                .filter(call -> matchesSubstring(call.id(), requestId))
                .filter(call -> matchesServiceNames(call, serviceNameFilter))
                .toList();
        CallListSupport.Page<CallRecord> page = CallListSupport.apply(
                idFiltered, java.util.function.Function.identity(), search, supplier, sort, offset, limit, paginationEnabled);
        return new CallListSupport.Page<>(page.items().stream().map(CallSummary::of).toList(), page.total());
    }

    private static boolean matchesSubstring(String value, String filter) {
        if (filter == null || filter.isBlank()) {
            return true;
        }
        return value != null && value.toLowerCase(java.util.Locale.ROOT).contains(filter.toLowerCase(java.util.Locale.ROOT));
    }

    /** Comma-separated project names (see CallsQuery.serviceNames) into a set - blank/empty input means "no filter", represented as an empty set rather than null so callers never need a separate null check. */
    private static java.util.Set<String> parseServiceNames(String serviceNames) {
        if (serviceNames == null || serviceNames.isBlank()) {
            return java.util.Set.of();
        }
        java.util.Set<String> names = new java.util.HashSet<>();
        for (String name : serviceNames.split(",")) {
            String trimmed = name.strip();
            if (!trimmed.isEmpty()) {
                names.add(trimmed);
            }
        }
        return names;
    }

    /** An empty filter set matches everything (no filter applied). A null serviceName (a call logged before this field existed) is treated as LoggingToggleService.UNKNOWN_NAME, same as every other read path. */
    private static boolean matchesServiceNames(CallRecord call, java.util.Set<String> filter) {
        if (filter.isEmpty()) {
            return true;
        }
        String name = call.serviceName() != null ? call.serviceName() : com.fathy.alfred.backend.internalcalls.application.service.LoggingToggleService.UNKNOWN_NAME;
        return filter.contains(name);
    }

    @Override
    public Optional<CallRecord> findById(String id) {
        return readAll().stream().filter(call -> id.equals(call.id())).findFirst();
    }

    @Override
    public synchronized long storageSizeBytes() {
        try {
            return Files.size(Path.of(internalCallsFile));
        } catch (IOException e) {
            return 0L;
        }
    }

    /** Loads the whole (ring-buffer-capped) list to count buckets - fine at this adapter's scale. */
    @Override
    public synchronized CallStatusBreakdown statusBreakdown() {
        long ok = 0, clientError = 0, serverError = 0;
        List<CallRecord> calls = readAll();
        for (CallRecord call : calls) {
            boolean hasError = call.error() != null && !call.error().isBlank();
            Integer status = call.response() != null ? call.response().status() : null;
            if (hasError || (status != null && status >= 500)) {
                serverError++;
            } else if (status != null && status >= 400) {
                clientError++;
            } else if (status != null && status >= 200) {
                ok++;
            }
        }
        // Always 0 - this adapter never persists an in-progress call to disk (see pendingById's
        // doc), so there's nothing on-disk to count into this bucket.
        return new CallStatusBreakdown(calls.size(), ok, clientError, serverError, 0);
    }

    @Override
    public synchronized void deleteAll() {
        Path path = Path.of(internalCallsFile);
        try {
            Files.deleteIfExists(path);
        } catch (IOException e) {
            log.error("Failed to delete {}: {}", internalCallsFile, e.getMessage());
        }
        invalidateCache();
        pendingById.clear();
        recentlyCompleted.clear();
        // The log is gone - tombstones have nothing left to hide.
        reliveDeletedCallIds.clear();
        try {
            Files.deleteIfExists(deletedJournal());
        } catch (IOException e) {
            log.error("Failed to delete the relive deleted-ids journal: {}", e.getMessage());
        }
    }

    /** Removes the calls attributed to the given Relive runs from every read - WITHOUT rewriting
     *  the file. One needle-guided scan ({@code "relive":{"runId":"}, plus the rarer
     *  ambiguousRunIds form) locates the attributed lines; their call ids are tombstoned, which
     *  filters them out of {@link #loadLines} - every read this adapter serves - from that
     *  instant on, and the ids are appended to a small journal next to the log so a restart
     *  doesn't resurrect them while retention still holds their bytes. The dead lines themselves
     *  age out with the retention ring: physically rewriting hundreds of MB inline was what made
     *  this delete take the better part of a minute. Still-pending two-phase calls of those runs
     *  are dropped from memory; they were never on disk to begin with. */
    @Override
    public int deleteByReliveRunIds(java.util.Collection<String> runIds) {
        if (runIds == null || runIds.isEmpty()) {
            return 0;
        }
        java.util.Set<String> ids = java.util.Set.copyOf(runIds);
        synchronized (this) {
            loadDeletedJournal();
        }
        // The scan reads the whole log - hundreds of MB - and holds no lock while it does: every
        // inbound webhook (save/complete) takes this adapter's monitor, and a delete used to stall
        // them all for its full duration (review B16). Only the bookkeeping below is locked.
        Needle attributed = new Needle("\"relive\":{\"runId\":\"".getBytes(StandardCharsets.UTF_8));
        Needle ambiguous = new Needle("\"relive\":{\"ambiguousRunIds\":[".getBytes(StandardCharsets.UTF_8));
        Path path = Path.of(internalCallsFile);
        if (!Files.exists(path)) {
            synchronized (this) {
                tombstone(removePendingOfRuns(ids));
            }
            return 0;
        }
        List<String> deletedIds = new ArrayList<>();
        try (java.io.InputStream in = new java.io.BufferedInputStream(Files.newInputStream(path), 1 << 20)) {
            byte[] chunk = new byte[1 << 20];
            byte[] line = new byte[1 << 16];
            int len = 0;
            int nRead;
            while ((nRead = in.read(chunk)) != -1) {
                for (int i = 0; i < nRead; i++) {
                    if (chunk[i] == '\n') {
                        collectIfDeleted(line, len, ids, attributed, ambiguous, deletedIds);
                        len = 0;
                    } else {
                        if (len == line.length) {
                            line = java.util.Arrays.copyOf(line, line.length * 2);
                        }
                        line[len++] = chunk[i];
                    }
                }
            }
            collectIfDeleted(line, len, ids, attributed, ambiguous, deletedIds);
        } catch (IOException e) {
            log.error("Failed to scan {} for relive-attributed calls: {}", internalCallsFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
        synchronized (this) {
            List<String> inFlight = removePendingOfRuns(ids);
            if (deletedIds.isEmpty() && inFlight.isEmpty()) {
                return 0;
            }
            List<String> all = new ArrayList<>(deletedIds);
            all.addAll(inFlight);
            tombstone(all);
            return deletedIds.size();
        }
    }

    /**
     * Drops the deleted runs' calls still in flight and returns their ids. They are tombstoned like the stored ones:
     * otherwise their completion, finding nothing pending, was stored from the completion alone - the deleted call
     * came back (caught by InternalCallStoreContractTest).
     */
    private List<String> removePendingOfRuns(java.util.Set<String> runIds) {
        List<String> removed = new ArrayList<>();
        pendingById.values().removeIf(call -> {
            boolean of = belongsToRun(call, runIds);
            if (of) {
                removed.add(call.id());
            }
            return of;
        });
        return removed;
    }

    private void tombstone(List<String> ids) {
        if (ids.isEmpty()) {
            return;
        }
        reliveDeletedCallIds.addAll(ids);
        appendDeletedJournal(ids);
    }

    /** Parses a scanned line only when its bytes mention run attribution at all, and collects the
     *  call id when the attribution really names one of the runs - so a body merely quoting a
     *  run id never causes a delete, and an unparseable line is kept. */
    private void collectIfDeleted(byte[] line, int len, java.util.Set<String> ids,
                                  Needle attributed, Needle ambiguous, List<String> out) {
        if (len == 0 || (indexOf(line, len, attributed) < 0 && indexOf(line, len, ambiguous) < 0)) {
            return;
        }
        try {
            com.fasterxml.jackson.databind.JsonNode node =
                    objectMapper.readTree(new String(line, 0, len, StandardCharsets.UTF_8));
            if (reliveMatchesRun(node.get("relive"), ids) && node.hasNonNull("id")) {
                out.add(node.get("id").asText());
            }
        } catch (Exception e) {
            // Not positively matched - the line stays.
        }
    }

    /** Call ids hidden from every read by the relive history delete, persisted next to the log:
     *  their lines remain on disk until the retention ring evicts them, and without this journal
     *  a restart would surface them again. */
    private final java.util.Set<String> reliveDeletedCallIds = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private boolean deletedJournalLoaded;

    private Path deletedJournal() {
        return Path.of(internalCallsFile + ".relive-deleted");
    }

    private void loadDeletedJournal() {
        if (deletedJournalLoaded) {
            return;
        }
        deletedJournalLoaded = true;
        Path journal = deletedJournal();
        if (!Files.exists(journal)) {
            return;
        }
        try {
            for (String id : Files.readAllLines(journal, StandardCharsets.UTF_8)) {
                String trimmed = id.strip();
                if (!trimmed.isEmpty()) {
                    reliveDeletedCallIds.add(trimmed);
                }
            }
        } catch (IOException e) {
            log.error("Could not read {}: tombstoned relive calls may reappear - {}", journal, e.getMessage());
        }
    }

    private void appendDeletedJournal(List<String> ids) {
        try {
            Files.writeString(deletedJournal(), String.join(System.lineSeparator(), ids) + System.lineSeparator(),
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            log.error("Could not append to the relive deleted-ids journal {}: {}", deletedJournal(), e.getMessage());
        }
    }

    /** A search needle with its Horspool bad-character shift table. Pure ASCII by construction. */
    private record Needle(byte[] bytes, int[] skip) {
        Needle(byte[] bytes) {
            this(bytes, skipTable(bytes));
        }

        private static int[] skipTable(byte[] pattern) {
            int[] skip = new int[256];
            java.util.Arrays.fill(skip, pattern.length);
            for (int i = 0; i < pattern.length - 1; i++) {
                skip[pattern[i] & 0xff] = pattern.length - 1 - i;
            }
            return skip;
        }
    }

    /** Horspool search over the first {@code len} bytes of {@code data}. */
    private static int indexOf(byte[] data, int len, Needle needle) {
        byte[] pattern = needle.bytes();
        int[] skip = needle.skip();
        int m = pattern.length;
        if (m == 0 || len < m) {
            return -1;
        }
        int i = m - 1;
        while (i < len) {
            int j = m - 1;
            while (j >= 0 && data[i - m + 1 + j] == pattern[j]) {
                j--;
            }
            if (j < 0) {
                return i - m + 1;
            }
            i += skip[data[i] & 0xff];
        }
        return -1;
    }

    private static boolean belongsToRun(CallRecord call, java.util.Set<String> runIds) {
        return reliveMatchesRun(call.relive(), runIds);
    }

    private static boolean reliveMatchesRun(com.fasterxml.jackson.databind.JsonNode relive, java.util.Set<String> runIds) {
        if (relive == null || relive.isMissingNode()) {
            return false;
        }
        com.fasterxml.jackson.databind.JsonNode runId = relive.get("runId");
        if (runId != null && runId.isTextual() && runIds.contains(runId.asText())) {
            return true;
        }
        com.fasterxml.jackson.databind.JsonNode ambiguous = relive.get("ambiguousRunIds");
        if (ambiguous != null && ambiguous.isArray()) {
            for (com.fasterxml.jackson.databind.JsonNode id : ambiguous) {
                if (id.isTextual() && runIds.contains(id.asText())) {
                    return true;
                }
            }
        }
        return false;
    }

    private static CallRecord withGeneratedId(CallRecord call) {
        return new CallRecord(UUID.randomUUID().toString(), call.originalUrl(), call.url(), call.method(),
                call.request(), call.timestamp(), call.durationMs(), call.response(), call.error());
    }

    /** Stores {@code lines} as the cache, stamped with the file's current size/mtime - or invalidates instead if the file can't be stat'd, so the next read re-parses rather than trusting an unverifiable snapshot. */
    private void rememberCache(Path path, List<CachedLine> lines) {
        BasicFileAttributes attributes = readAttributes(path);
        if (attributes == null) {
            invalidateCache();
            return;
        }
        cachedLines = List.copyOf(lines);
        cachedFileSize = attributes.size();
        cachedModifiedMillis = attributes.lastModifiedTime().toMillis();
    }

    private void invalidateCache() {
        cachedLines = null;
        cachedFileSize = -1;
        cachedModifiedMillis = -1;
        linesOnDisk = -1;
    }

    private BasicFileAttributes readAttributes(Path path) {
        try {
            return Files.readAttributes(path, BasicFileAttributes.class);
        } catch (IOException e) {
            return null;
        }
    }

    /**
     * Percentiles over the in-memory cache this adapter already keeps. The file is ring-buffered at
     * alfred.internal-calls.max-limit, so this is a baseline over recent traffic rather than all of
     * history - sorting a few hundred doubles is cheap, and there is no index here to lean on.
     */
    @Override
    public CallBaseline baselineFor(String url) {
        List<Double> durations = readAll().stream()
                .filter(call -> url.equals(call.url()))
                .filter(call -> call.state() != CallLifecycleStatus.IN_PROGRESS && call.durationMs() != null)
                .map(CallRecord::durationMs)
                .sorted()
                .toList();
        if (durations.isEmpty()) {
            return CallBaseline.empty(url);
        }
        return new CallBaseline(url, durations.size(), at(durations, 0.50), at(durations, 0.95));
    }

    private static Double at(List<Double> sorted, double percentile) {
        int index = Math.min(sorted.size() - 1, Math.max(0, (int) Math.floor(sorted.size() * percentile)));
        return sorted.get(index);
    }

    @Override
    public void appendWsMessages(String callId, List<com.fathy.alfred.backend.internalcalls.domain.model.WsMessage> messages,
                                  boolean closed, Integer closeCode) {
        if (messages.isEmpty()) {
            return;
        }
        List<com.fathy.alfred.backend.internalcalls.domain.model.WsMessage> existing =
                wsMessagesByCallId.computeIfAbsent(callId, id -> Collections.synchronizedList(new ArrayList<>()));
        synchronized (existing) {
            existing.addAll(messages);
            int overflow = existing.size() - wsMaxMessages;
            if (overflow > 0) {
                existing.subList(0, overflow).clear();
                wsDroppedByCallId.merge(callId, overflow, Integer::sum);
            }
        }
    }

    @Override
    public com.fathy.alfred.backend.internalcalls.domain.model.WsMessagesPage wsMessages(String callId, int offset, int limit) {
        List<com.fathy.alfred.backend.internalcalls.domain.model.WsMessage> all = wsMessagesByCallId.getOrDefault(callId, List.of());
        List<com.fathy.alfred.backend.internalcalls.domain.model.WsMessage> page;
        int total;
        synchronized (all) {
            total = all.size();
            page = all.stream().skip(Math.max(0, offset)).limit(Math.max(0, limit)).toList();
        }
        return new com.fathy.alfred.backend.internalcalls.domain.model.WsMessagesPage(
                page, total, wsDroppedByCallId.getOrDefault(callId, 0));
    }
}
