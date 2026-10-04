package com.fathy.alfred.backend.logs.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.application.port.out.LineSourcePort;
import com.fathy.alfred.backend.logs.application.port.out.LogInputStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogLineStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogNotificationPort;
import com.fathy.alfred.backend.logs.application.port.out.LogSourceStorePort;
import com.fathy.alfred.backend.logs.domain.ingest.LineBuilder;
import com.fathy.alfred.backend.logs.domain.ingest.PatternMiner;
import com.fathy.alfred.backend.logs.domain.ingest.PayloadRule;
import com.fathy.alfred.backend.logs.domain.ingest.ShapeMatcher;
import com.fathy.alfred.backend.logs.domain.ingest.StructureDetector;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.InputKind;
import com.fathy.alfred.backend.logs.domain.model.InputStatus;
import com.fathy.alfred.backend.logs.domain.model.IngestProgress;
import com.fathy.alfred.backend.logs.domain.model.LineRecord;
import com.fathy.alfred.backend.logs.domain.model.LogInput;
import com.fathy.alfred.backend.logs.domain.model.LogSource;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.Pattern;
import com.fathy.alfred.backend.logs.domain.model.PrivacyMode;
import com.fathy.alfred.backend.logs.domain.model.RawMode;
import com.fathy.alfred.backend.logs.domain.model.SearchMode;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The single ingest pipeline every input feeds (research §R4): read complete lines from the saved
 * position, parse/flatten/type them, and store them in batches of {@link #BATCH} in one transaction
 * together with the input's new position. Heap use is one batch, never the file (constitution II).
 *
 * <p>One job thread per running input. Work on one source (structure changes, pattern mining,
 * batch writes) is serialised on that source's lock, so two inputs of the same source never race.
 */
@Service
public class LogIngestService {

    private static final Logger log = LoggerFactory.getLogger(LogIngestService.class);

    static final int BATCH = 5_000;
    /**
     * A batch also ends at this much raw text. Lines differ wildly in width (a 300-byte line vs an 11 KB
     * line with a request/response payload of ~900 fields); 5,000 wide lines parsed at once held well
     * over the 1 GB heap and the backend ran out of memory. Bytes bound the batch's memory, not lines.
     */
    static final long BATCH_BYTES = 8L * 1024 * 1024;
    /** Threads that parse a batch. Not the JVM-wide common pool: that one is sized to every CPU of the host. */
    static final int PARSE_THREADS = 4;
    /** Retention trims to this share of the cap, so it runs once per many batches, not every batch. */
    static final double RETENTION_TARGET = 0.9;
    /** Bits of a stored byte offset that hold the offset; the bits above hold the rotation generation. */
    public static final int OFFSET_BITS = 40;
    private static final long OFFSET_MASK = (1L << OFFSET_BITS) - 1;

    private final LogSourceStorePort sources;
    private final LogInputStorePort inputs;
    private final LogLineStorePort lines;
    private final LineSourcePort lineSource;
    private final LogNotificationPort notifications;
    final LineBuilder builder;
    private final ExecutorService jobs = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "logs-ingest");
        t.setDaemon(true);
        return t;
    });
    private final java.util.concurrent.ForkJoinPool parsers = new java.util.concurrent.ForkJoinPool(PARSE_THREADS,
            pool -> {
                java.util.concurrent.ForkJoinWorkerThread t = java.util.concurrent.ForkJoinPool.defaultForkJoinWorkerThreadFactory.newThread(pool);
                t.setName("logs-parse-" + t.getPoolIndex());
                t.setDaemon(true);
                return t;
            }, null, false);
    private final Map<String, AtomicBoolean> running = new ConcurrentHashMap<>();
    private final Map<String, Object> sourceLocks = new ConcurrentHashMap<>();
    private final Map<String, PatternMiner> miners = new ConcurrentHashMap<>();
    private final Map<String, ShapeMatcher> shapeMatchers = new ConcurrentHashMap<>();

    @Value("${LOGS_DB_FILE:/appdata/logs.db}")
    private String dbFile;
    @Value("${LOGS_MIN_FREE_BYTES:2147483648}")
    private long minFreeBytes;
    @Value("${LOGS_FOLLOW_STAT_MS:1000}")
    private long followStatMs;

    private final LogsChangeTracker tracker;
    private final FileChangeSignals signals;

    public LogIngestService(LogSourceStorePort sources, LogInputStorePort inputs, LogLineStorePort lines, LineSourcePort lineSource,
                            LogNotificationPort notifications, ObjectMapper objectMapper, LogsChangeTracker tracker,
                            FileChangeSignals signals) {
        this.tracker = tracker;
        this.signals = signals;
        this.sources = sources;
        this.inputs = inputs;
        this.lines = lines;
        this.lineSource = lineSource;
        this.notifications = notifications;
        this.builder = new LineBuilder(objectMapper);
    }

    public static long compose(int generation, long offset) {
        return ((long) generation << OFFSET_BITS) | (offset & OFFSET_MASK);
    }

    public static int generationOf(long position) {
        return (int) (position >>> OFFSET_BITS);
    }

    public static long offsetOf(long position) {
        return position & OFFSET_MASK;
    }

    Object lockFor(String sourceId) {
        return sourceLocks.computeIfAbsent(sourceId, k -> new Object());
    }

    /** Marks an input resumed after a restart until its first batch is stored. */
    static final String RESUME_MARK = "Resumed after a restart";

    /**
     * Resume whatever was loading or following when the backend stopped (FR-006). An input that was
     * already resumed once and never stored a batch since is not resumed again: it is what stopped the
     * backend (e.g. out of memory, which exits the JVM), and resuming it would stop it again, forever.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void resumeAll() {
        for (LogInput in : inputs.all()) {
            if (EnumSet.of(InputStatus.LOADING, InputStatus.FOLLOWING, InputStatus.WAITING, InputStatus.QUEUED).contains(in.status())
                    && in.path() != null && in.kind() != InputKind.WATCH) { // a folder has no reader; its files do
                if (RESUME_MARK.equals(in.statusReason())) {
                    saveStatus(in, InputStatus.FAILED, "Stopped the backend twice while loading (e.g. out of memory) - retry when fixed");
                    continue;
                }
                inputs.save(in.withStatus(in.status(), RESUME_MARK));
                start(inputs.get(in.id()).orElse(in));
            }
        }
    }

    /** Set when the backend stops: a reader interrupted by that is resumed on the next start, not failed. */
    private volatile boolean shuttingDown;

    @PreDestroy
    void shutdown() {
        shuttingDown = true;
        running.values().forEach(f -> f.set(true));
        jobs.shutdownNow();
        parsers.shutdownNow();
    }

    public boolean isRunning(String inputId) {
        return running.containsKey(inputId);
    }

    public void start(LogInput input) {
        AtomicBoolean stop = new AtomicBoolean(false);
        if (running.putIfAbsent(input.id(), stop) != null) {
            return;
        }
        jobs.submit(() -> {
            try {
                run(input.id(), stop);
            } catch (OutOfMemoryError e) {
                // Never left showing "loading" forever: the input says what happened and can be retried.
                log.error("Log input {} ran out of memory", input.id(), e);
                inputs.get(input.id()).ifPresent(in -> saveStatus(in, InputStatus.FAILED,
                        "Ran out of memory - lines too wide for the backend's memory; retry, or mark big payload groups Not searched"));
            } catch (Throwable e) {
                if (shuttingDown) {
                    // Interrupted by the backend stopping: the status stays LOADING/FOLLOWING, so the next
                    // start resumes it from its saved position (resumeAll).
                    log.info("Log input {} stopped with the backend; it resumes on the next start", input.id());
                    return;
                }
                log.error("Log input {} failed", input.id(), e);
                inputs.get(input.id()).ifPresent(in -> saveStatus(in, InputStatus.FAILED, "Loading stopped: " + e.getClass().getSimpleName()));
            } finally {
                running.remove(input.id());
            }
        });
    }

    /** Stops a running input after its current batch; the caller sets the status it wants. */
    public void stop(String inputId) {
        AtomicBoolean flag = running.get(inputId);
        if (flag != null) {
            flag.set(true);
            signals.signal(inputId); // a watched file waiting for a change notification wakes and stops
        }
        for (int i = 0; i < 100 && running.containsKey(inputId); i++) {
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    /** Drops the cached pattern miner and structure matcher so the next batch reloads them from storage. */
    public void forgetSource(String sourceId) {
        miners.remove(sourceId);
        shapeMatchers.remove(sourceId);
        tracker.changed(sourceId);
    }

    /** What queries return for this source changed: cached aggregates are dropped (see LogsChangeTracker). */
    public void changed(String sourceId) {
        tracker.changed(sourceId);
    }

    /** This source's structure matcher; callers hold {@link #lockFor} (one writer per source). */
    ShapeMatcher shapes(String sourceId) {
        return shapeMatchers.computeIfAbsent(sourceId, id -> new ShapeMatcher(lines.shapes(id)));
    }

    private void run(String inputId, AtomicBoolean stop) throws IOException, InterruptedException {
        LogInput input = inputs.get(inputId).orElseThrow();
        LogSource source = sources.get(input.sourceId()).orElseThrow();
        boolean follow = input.followed();
        boolean notified = input.kind() == InputKind.WATCHED_FILE; // waits for change notifications, no timer
        Path path = Path.of(input.path());
        if (!Files.exists(path) && !follow) {
            saveStatus(input, InputStatus.FAILED, "File not found");
            return;
        }
        long startPos = input.position();
        try (LineSourcePort.Reader reader = lineSource.open(input.path(), generationOf(startPos), offsetOf(startPos))) {
            input = withTotal(input, reader.size());
            saveStatus(input, follow ? InputStatus.FOLLOWING : InputStatus.LOADING, RESUME_MARK.equals(input.statusReason()) ? RESUME_MARK : null);
            List<LineSourcePort.RawLine> batch = new ArrayList<>(BATCH);
            long batchBytes = 0;
            long lastTs = System.currentTimeMillis();
            while (!stop.get()) {
                // Free space is checked once per batch (a stat call per line would halve throughput).
                if (batch.isEmpty() && lowDisk()) {
                    flush(source.id(), input, batch, lastTs);
                    saveStatus(inputs.get(inputId).orElse(input), InputStatus.PAUSED, "LOW_DISK");
                    return;
                }
                LineSourcePort.RawLine line = reader.next();
                if (line != null) {
                    batch.add(line);
                    batchBytes += line.bytes().length;
                    if (batch.size() >= BATCH || batchBytes >= BATCH_BYTES) {
                        lastTs = flush(source.id(), input, batch, lastTs);
                        batchBytes = 0;
                    }
                    continue;
                }
                lastTs = flush(source.id(), input, batch, lastTs);
                batchBytes = 0;
                LogInput caughtUp = inputs.get(inputId).orElse(input);
                if (RESUME_MARK.equals(caughtUp.statusReason())) {
                    // Read to the end after a restart: the resume worked. Without this an idle followed file
                    // (no new line to store a batch) kept the mark, and the NEXT restart failed it as
                    // "stopped the backend twice".
                    inputs.save(caughtUp.withStatus(caughtUp.status(), null));
                }
                if (!follow) {
                    saveStatus(inputs.get(inputId).orElse(input), InputStatus.DONE, null);
                    return;
                }
                boolean present;
                if (notified) {
                    // Rotation and data written since the last read are checked without waiting; only
                    // when there is truly nothing new does the reader block until notified.
                    present = reader.awaitMore(0);
                    if (!reader.hasUnread() && !signals.await(inputId, stop::get)) {
                        break;
                    }
                    present = reader.awaitMore(0);
                } else {
                    // A single followed file under /logs: Docker Desktop bind mounts deliver no change
                    // events, so it is checked every LOGS_FOLLOW_STAT_MS (watched folders are notified).
                    present = reader.awaitMore(followStatMs);
                }
                LogInput now = inputs.get(inputId).orElse(input);
                InputStatus want = present ? InputStatus.FOLLOWING : InputStatus.WAITING;
                if (now.status() != want) {
                    saveStatus(now, want, present ? null : "Waiting for the file to appear");
                }
                input = withTotal(now, reader.size());
            }
            flush(source.id(), input, batch, lastTs);
        }
    }

    private LogInput withTotal(LogInput in, long total) {
        return new LogInput(in.id(), in.sourceId(), in.kind(), in.path(), in.fileName(), in.fingerprint(), in.status(),
                in.statusReason(), in.position(), in.linesRead(), total, in.mismatchCount(), in.unparsedCount(), in.startedAt(),
                in.updatedAt());
    }

    private boolean lowDisk() {
        try {
            Path dir = Path.of(dbFile).toAbsolutePath().getParent();
            return dir != null && Files.getFileStore(dir).getUsableSpace() < minFreeBytes;
        } catch (IOException e) {
            return false;
        }
    }

    /** Builds and stores one batch; returns the time of its last line (the next line's fallback time). */
    private long flush(String sourceId, LogInput input, List<LineSourcePort.RawLine> batch, long lastTs) {
        if (batch.isEmpty()) {
            return lastTs;
        }
        synchronized (lockFor(sourceId)) {
            LogSource source = sources.get(sourceId).orElseThrow();
            LogStructure structure = sources.structure(sourceId).orElseThrow();
            PatternMiner miner = miner(sourceId);
            boolean copy = source.rawMode() == RawMode.COPY;
            boolean redact = source.privacyMode() == PrivacyMode.REDACT_AT_LOAD;
            List<LineRecord> records = new ArrayList<>(batch.size());
            List<PatternMiner.Cluster> changed = new ArrayList<>();
            ShapeMatcher shapes = shapes(sourceId);
            String newField = null;
            long unparsed = 0;
            long last = lastTs;
            // Parsing and flattening is pure CPU work per line, so it runs on PARSE_THREADS cores; pattern mining,
            // new-field registration and the write below stay sequential (one writer per source).
            List<LineBuilder.Parsed> parsedLines = parseAll(batch, structure, redact);
            // Payload option A: new paths that form a big or id-keyed part become ONE field. Decided for
            // the whole batch first, then the batch is parsed again so its lines carry the payload value.
            java.util.Set<String> batchNew = new java.util.LinkedHashSet<>();
            parsedLines.forEach(pl -> batchNew.addAll(pl.newPaths().keySet()));
            if (!batchNew.isEmpty()) {
                List<String> leafPaths = new ArrayList<>(structure.fields().stream().filter(FieldDef::stored).map(FieldDef::path).toList());
                leafPaths.addAll(batchNew);
                java.util.Set<String> payloads = new java.util.LinkedHashSet<>(PayloadRule.bodies(
                        structure.fields().stream().filter(f -> PayloadRule.bodyRole(f.role())).map(FieldDef::path).toList(),
                        leafPaths, structure.payloadPaths()));
                List<String> known = new ArrayList<>(structure.payloadPaths());
                known.addAll(payloads);
                payloads.addAll(PayloadRule.choose(leafPaths, known, keptPaths(structure)));
                if (!payloads.isEmpty()) {
                    List<String> all = new ArrayList<>(structure.payloadPaths());
                    all.addAll(payloads);
                    structure = structure.withPayloads(all);
                    sources.saveStructure(sourceId, structure);
                    log.info("Log source {}: kept as one field each (payloads): {}", sourceId, payloads);
                    parsedLines = parseAll(batch, structure, redact);
                }
            }
            for (int k = 0; k < batch.size(); k++) {
                LineSourcePort.RawLine raw = batch.get(k);
                LineBuilder.Parsed parsed = parsedLines.get(k);
                if (!parsed.newPaths().isEmpty()) {
                    // An earlier line of this batch may already have registered some of these paths.
                    java.util.Set<String> known = new java.util.HashSet<>(structure.fields().stream().map(f -> f.path()).toList());
                    java.util.Map<String, Object> fresh = new java.util.LinkedHashMap<>();
                    parsed.newPaths().forEach((path, v) -> {
                        if (!known.contains(path)) {
                            fresh.put(path, v);
                        }
                    });
                    if (!fresh.isEmpty()) {
                        LogStructure before = structure;
                        structure = addFields(sourceId, structure, fresh, input.linesRead() + records.size());
                        if (structure.fields().size() > before.fields().size()) {
                            newField = structure.fields().get(before.fields().size()).path();
                        }
                    }
                }
                long offset = compose(raw.generation(), raw.offset());
                LineRecord r = builder.toRecord(parsed, structure, input.id() + ":" + offset, input.id(), offset, copy, last, miner,
                        changed, shapes);
                last = r.ts();
                unparsed += r.unparsed() ? 1 : 0;
                records.add(r);
            }
            LineSourcePort.RawLine end = batch.get(batch.size() - 1);
            long position = compose(end.generation(), end.nextOffset());
            List<Pattern> patterns = changed.stream().map(c -> new Pattern(c.id(), c.template(), 0, null)).toList();
            int inserted;
            try {
                inserted = lines.append(sourceId, structure, new LogLineStorePort.Batch(records, patterns, shapes.drainChanged(),
                        input.id(), position, batch.size(), unparsed));
            } catch (RuntimeException e) {
                forgetSource(sourceId); // the in-memory counts ran ahead of what was stored
                throw e;
            }
            batch.clear();
            tracker.changed(sourceId);
            applyRetention(sourceId);
            LogInput now = inputs.get(input.id()).orElse(input);
            if (RESUME_MARK.equals(now.statusReason())) {
                now = now.withStatus(now.status(), null); // a batch went through: the resume worked
                inputs.save(now);
            }
            notifications.progress(new IngestProgress(sourceId, input.id(), now.status(), now.statusReason(), now.linesRead(),
                    offsetOf(now.position()), input.totalBytes(), now.unparsedCount(), now.mismatchCount(), newField));
            if (inserted > 0) {
                notifications.linesAdded(sourceId, inserted, last);
            }
            return last;
        }
    }

    /** Fields the user relies on - roles, grouping levels, columns, template tokens - never go inside a payload. */
    static List<String> keptPaths(LogStructure s) {
        java.util.Set<String> labels = new java.util.HashSet<>(s.columns());
        s.groupLevels().forEach(l -> labels.add(l.fieldLabel()));
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\{([^}]+)}").matcher(s.template() == null ? "" : s.template());
        while (m.find()) {
            labels.add(m.group(1));
        }
        return s.fields().stream().filter(f -> (f.role() != null && !PayloadRule.bodyRole(f.role())) || labels.contains(f.label()))
                .map(FieldDef::path).toList();
    }

    /** Parses a batch on the parse pool (PARSE_THREADS cores), keeping line order. */
    private List<LineBuilder.Parsed> parseAll(List<LineSourcePort.RawLine> batch, LogStructure structure, boolean redact) {
        try {
            return parsers.submit(() -> batch.parallelStream().map(raw -> builder.parse(raw.bytes(), structure, redact)).toList()).get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while parsing", e);
        } catch (java.util.concurrent.ExecutionException e) {
            if (e.getCause() instanceof Error err) {
                throw err;
            }
            throw new IllegalStateException("Parsing failed", e.getCause());
        }
    }

    private PatternMiner miner(String sourceId) {
        return miners.computeIfAbsent(sourceId, id -> {
            PatternMiner m = new PatternMiner(1);
            lines.storedPatterns(id).forEach(p -> m.restore(p.id(), p.template()));
            return m;
        });
    }

    /**
     * New fields seen after the sample (FR-010) - from any line, whatever its structure: stored from
     * now on, announced on the Load screen. Past {@link LogStructure#MAX_STORED_FIELDS} a field is only
     * counted: it stays in the raw line and the JSON view, unsearchable.
     *
     * @param index false registers would-be Exact fields as Not searched instead of building their index
     *              (used when many stored lines already exist and an index build would block writers)
     */
    LogStructure addFields(String sourceId, LogStructure s, Map<String, Object> fresh, long lineNumber) {
        return addFields(sourceId, s, fresh, lineNumber, true);
    }

    LogStructure addFields(String sourceId, LogStructure s, Map<String, Object> fresh, long lineNumber, boolean index) {
        List<FieldDef> fields = new ArrayList<>(s.fields());
        List<String> allPaths = new ArrayList<>(fields.stream().map(FieldDef::path).toList());
        allPaths.addAll(fresh.keySet());
        int next = s.nextIndex();
        long stored = s.storedCount();
        List<String> overflow = new ArrayList<>(s.overflowPaths());
        List<FieldDef> added = new ArrayList<>();
        for (var e : fresh.entrySet()) {
            if (stored >= LogStructure.MAX_STORED_FIELDS || fields.size() >= LogStructure.MAX_FIELDS) {
                if (overflow.size() < LogStructure.MAX_OVERFLOW_LISTED && !overflow.contains(e.getKey())) {
                    overflow.add(e.getKey());
                }
                continue;
            }
            stored++;
            String label = StructureDetector.shortestUniqueSuffix(e.getKey(), allPaths,
                    fields.stream().map(FieldDef::label).toList());
            FieldDef f = StructureDetector.newField(next++, e.getKey(), label, e.getValue(), lineNumber);
            if (!index && f.searchMode() == SearchMode.EXACT) {
                f = f.withSearchMode(SearchMode.NONE);
            }
            fields.add(f);
            added.add(f);
        }
        if (added.isEmpty() && overflow.size() == s.overflowPaths().size()) {
            return s;
        }
        LogStructure updated = s.withFields(fields).withOverflow(overflow);
        sources.saveStructure(sourceId, updated);
        tracker.changed(sourceId);
        lines.ensureFields(sourceId, added);
        for (FieldDef f : added) {
            if (f.searchMode() == SearchMode.EXACT) {
                lines.setIndex(sourceId, f, true);
            }
        }
        notifications.structureChanged(sourceId, null);
        return updated;
    }

    /** Size cap only (FR-009 as amended): 0 keeps every line; otherwise oldest unpinned lines go first. */
    void applyRetention(String sourceId) {
        LogSource s = sources.get(sourceId).orElseThrow();
        if (s.retentionMaxBytes() <= 0 || s.storedBytes() <= s.retentionMaxBytes()) {
            return;
        }
        long[] removed = lines.applyRetention(sourceId, s.storedBytes(), (long) (s.retentionMaxBytes() * RETENTION_TARGET));
        if (removed[0] > 0) {
            long[] counts = lines.counts(sourceId);
            sources.setCounts(sourceId, counts[0], counts[1]);
            lines.rebuildGroups(sourceId);
            lines.recountShapes(sourceId, sources.structure(sourceId).orElseThrow().fields().stream().filter(FieldDef::stored).toList());
            shapeMatchers.remove(sourceId);
            log.info("Retention removed {} lines from log source {}", removed[0], sourceId);
        }
    }

    private void saveStatus(LogInput in, InputStatus status, String reason) {
        LogInput updated = in.withStatus(status, reason);
        inputs.save(updated);
        notifications.progress(new IngestProgress(in.sourceId(), in.id(), status, reason, updated.linesRead(),
                offsetOf(updated.position()), updated.totalBytes(), updated.unparsedCount(), updated.mismatchCount(), null));
        notifications.sourcesChanged();
    }
}
