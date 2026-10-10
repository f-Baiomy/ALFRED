package com.fathy.alfred.backend.storage;

import com.fathy.alfred.backend.calls.application.port.in.SetStorageBudgetUseCase;
import com.fathy.alfred.backend.comments.application.port.out.CommentsStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.in.SetCaptureBudgetUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.SetRetentionUseCase;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogSourcesUseCase;
import com.fathy.alfred.backend.relive.application.port.in.DeleteRunHistoryCommand;
import com.fathy.alfred.backend.relive.application.port.in.DeleteRunHistoryUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ListRunsUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycleSummary;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;
import com.fathy.alfred.backend.sessioncycles.application.port.in.DeleteSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.FileStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * The storage page's brain (Settings → Storage): measures every store, applies the storage budget as each slice's own
 * limits (ratios of one number), gives empty space back, and runs targeted clean-ups. Lives in the composition root
 * because it reads and configures many slices - the same reason {@code DatabaseStatsController} does. Deleting calls
 * goes through the stores' own delete, so the deletion cascade takes what was captured with them.
 */
@Service
public class StorageService {

    private static final Logger log = LoggerFactory.getLogger(StorageService.class);
    static final int MAX_CLEANUP = 200_000;
    /** relive.db's tables that grow with every run - deleted with a run's history, never with the cycle definition. */
    static final Set<String> RUN_HISTORY_TABLES = Set.of("relive_runs", "relive_step_results", "relive_live_calls");
    private static final int DELETE_CHUNK = 1_000;
    private static final long MB = 1024L * 1024;
    /** "No count limit" for the inbound store, whose row cap is always on: the size share does the limiting. */
    static final int NO_CALL_LIMIT = 100_000_000;

    private final StorageFiles files;
    private final com.fathy.alfred.backend.calls.application.port.out.CallLogPort outbound;
    private final com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort inbound;
    private final SetStorageBudgetUseCase outboundLimits;
    private final SetRetentionUseCase inboundLimits;
    private final SetCaptureBudgetUseCase captureLimits;
    private final CommentsStorePort comments;
    private final ListSessionCyclesUseCase cycles;
    private final DeleteSessionCycleUseCase deleteCycle;
    private final ManageReliveCyclesUseCase reliveCycles;
    private final ListRunsUseCase runs;
    private final DeleteRunHistoryUseCase deleteRuns;
    private final ManageLogSourcesUseCase logSources;
    private final Clock clock;
    /** The page's own deletes run inside it, so the history does not count them again as "Auto". */
    private StorageActivity activity;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setActivity(StorageActivity activity) {
        this.activity = activity;
    }

    private RecordingRules recordingRules;
    private CommentedCallsKept commentedKept;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setRuleCaches(RecordingRules recordingRules, CommentedCallsKept commentedKept) {
        this.recordingRules = recordingRules;
        this.commentedKept = commentedKept;
    }

    private <T> T manual(java.util.function.Supplier<T> work) {
        return activity == null ? work.get() : activity.manual(work);
    }

    public StorageService(StorageFiles files,
                          com.fathy.alfred.backend.calls.application.port.out.CallLogPort outbound,
                          com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort inbound,
                          SetStorageBudgetUseCase outboundLimits, SetRetentionUseCase inboundLimits, SetCaptureBudgetUseCase captureLimits,
                          CommentsStorePort comments, ListSessionCyclesUseCase cycles, DeleteSessionCycleUseCase deleteCycle,
                          ManageReliveCyclesUseCase reliveCycles, ListRunsUseCase runs, DeleteRunHistoryUseCase deleteRuns,
                          ManageLogSourcesUseCase logSources, Optional<Clock> clock) {
        this.files = files;
        this.outbound = outbound;
        this.inbound = inbound;
        this.outboundLimits = outboundLimits;
        this.inboundLimits = inboundLimits;
        this.captureLimits = captureLimits;
        this.comments = comments;
        this.cycles = cycles;
        this.deleteCycle = deleteCycle;
        this.reliveCycles = reliveCycles;
        this.runs = runs;
        this.deleteRuns = deleteRuns;
        this.logSources = logSources;
        this.clock = clock.orElse(Clock.systemUTC());
    }

    // ================================================================== overview

    record Disk(String path, long freeBytes, long totalBytes) {
    }

    /**
     * One kind of data. {@code share} is the budget share it counts against ("work" is never deleted); {@code
     * limitBytes} its share of the budget (or null), {@code limitCalls} a count limit (or null).
     */
    record Store(String id, String name, String group, String share, String files, long items, String unit,
                 long sizeBytes, long freeBytes, long walBytes, String oldest, Long limitBytes, Integer limitCalls, boolean cleanable) {
    }

    record ReliveCycleRuns(String id, String name, int steps, String lastRun, List<RunView> runs) {
    }

    record RunView(String id, String status, String startedAt, boolean starred) {
    }

    /** {@code lowDisk}: free disk is under the warning rule's limit - the page and every tab's banner say so. */
    record Overview(long usedBytes, long freeInsideBytes, Disk disk, StorageBudget budget, Map<String, Long> shareBytes,
                    Map<String, Long> shareUsed, long maxBudgetBytes, List<Store> stores, List<ReliveCycleRuns> relive,
                    List<StorageFiles.HistoryEntry> history, boolean lowDisk) {
    }

    /** The cheap part of the overview, for the banner every tab shows when the disk runs low. */
    record DiskState(long freeBytes, long totalBytes, boolean lowDisk, int warnGb) {
    }

    public DiskState diskState() {
        Disk d = disk();
        int warn = files.loadBudget().rulesOrDefault().lowDiskWarnGb();
        return new DiskState(d.freeBytes(), d.totalBytes(), warn > 0 && d.freeBytes() >= 0 && d.freeBytes() < warn * StorageBudget.GB, warn);
    }

    public Overview overview() {
        StorageBudget budget = files.loadBudget();
        Map<String, Long> shares = budget.shareBytes();
        List<Store> stores = new ArrayList<>();

        SqliteFiles.FileStats in = SqliteFiles.stats(files.file("internal-calls.db"));
        stores.add(new Store("inbound", "Inbound calls", "traffic", "inbound", "internal-calls.db",
                safeCount(() -> inbound.statusBreakdown().total()), "calls", in.totalBytes(), in.freeBytes(), in.walBytes(),
                safeText(inbound::oldestTimestamp), limit(budget, shares, "inbound"),
                budget.isSet() && budget.inboundMaxCalls() > 0 ? budget.inboundMaxCalls() : null, true));

        SqliteFiles.FileStats out = SqliteFiles.stats(files.file("calls.db"));
        stores.add(new Store("outbound", "Outbound calls", "traffic", "outbound", "calls.db",
                safeCount(() -> outbound.statusBreakdown().total()), "calls", out.totalBytes(), out.freeBytes(), out.walBytes(),
                safeText(outbound::oldestTimestamp), limit(budget, shares, "outbound"),
                budget.isSet() && budget.outboundMaxCalls() > 0 ? budget.outboundMaxCalls() : null, true));

        Path capture = files.file("db-capture.db");
        SqliteFiles.FileStats cap = SqliteFiles.stats(capture);
        stores.add(new Store("capture", "DB statements, Redis & caught logs", "capture", "capture", "db-capture.db",
                SqliteFiles.number(capture, "SELECT COUNT(*) FROM statements").orElse(0), "statements", cap.totalBytes(),
                cap.freeBytes(), cap.walBytes(), SqliteFiles.text(capture, "SELECT MIN(first_seen) FROM call_db_summary"),
                limit(budget, shares, "capture"), null, false));

        Path triage = files.file("triage.db");
        SqliteFiles.FileStats tri = SqliteFiles.stats(triage);
        stores.add(new Store("triage", "Triage marks", "capture", "capture", "triage.db",
                SqliteFiles.number(triage, "SELECT COUNT(*) FROM call_attention").orElse(0), "marks", tri.totalBytes(),
                tri.freeBytes(), tri.walBytes(), null, null, null, false));

        SqliteFiles.FileStats lg = SqliteFiles.stats(files.file("logs.db"));
        long lines = 0;
        try {
            lines = logSources.list().stream().mapToLong(v -> v.source().lineCount()).sum();
        } catch (RuntimeException e) {
            log.debug("Log sources not readable: {}", e.getMessage());
        }
        stores.add(new Store("logs", "Logs", "capture", "logs", "logs.db", lines, "lines", lg.totalBytes(), lg.freeBytes(),
                lg.walBytes(), null, limit(budget, shares, "logs"), null, false));

        // session-cycles.db holds your cycles AND each Relive run's recording: split by their captured calls
        Path sc = files.file("session-cycles.db");
        SqliteFiles.FileStats scs = SqliteFiles.stats(sc);
        List<SessionCycle> all = safeList(cycles::listAll);
        long userCycles = all.stream().filter(c -> c.reliveRunId() == null).count();
        long runCycles = all.size() - userCycles;
        long captured = SqliteFiles.number(sc, "SELECT COUNT(*) FROM captured_call_metadata").orElse(0);
        long capturedInRuns = SqliteFiles.number(sc, "SELECT COUNT(*) FROM captured_call_metadata WHERE cycle_id IN "
                + "(SELECT id FROM session_cycles WHERE relive_run_id IS NOT NULL)").orElse(0);
        double runShare = captured == 0 ? (all.isEmpty() ? 0 : (double) runCycles / all.size()) : (double) capturedInRuns / captured;
        long runBytes = Math.round((scs.totalBytes() - scs.freeBytes()) * runShare);
        long userBytes = scs.totalBytes() - runBytes;
        stores.add(new Store("cycles", "Session cycles", "work", "work", "session-cycles.db", userCycles, "cycles",
                userBytes, scs.freeBytes(), scs.walBytes(), all.stream().filter(c -> c.reliveRunId() == null)
                .map(SessionCycle::createdAt).filter(s -> s != null).min(String::compareTo).orElse(null), null, null, true));
        stores.add(new Store("reliveRuns", "Relive run recordings", "relive", "reliveRuns", "session-cycles.db (run cycles)",
                runCycles, "runs", runBytes, 0, 0, null, limit(budget, shares, "reliveRuns"), null, true));

        // relive.db holds the cycles (your work) AND their run history (results, Live calls log): the history counts
        // toward the Relive runs share, so "last N runs" is what frees it
        Path rl = files.file("relive.db");
        SqliteFiles.FileStats rls = SqliteFiles.stats(rl);
        Map<String, Long> reliveTables = SqliteFiles.tableBytes(rl);
        long historyBytes = reliveTables.entrySet().stream().filter(e -> RUN_HISTORY_TABLES.contains(e.getKey()))
                .mapToLong(Map.Entry::getValue).sum();
        long cycleBytes = Math.max(0, rls.totalBytes() - historyBytes);
        stores.add(new Store("relive", "Relive cycles", "relive", "work", "relive.db",
                SqliteFiles.number(rl, "SELECT COUNT(*) FROM relive_cycles").orElse(0), "cycles", cycleBytes, rls.freeBytes(),
                rls.walBytes(), null, null, null, false));
        stores.add(new Store("reliveHistory", "Relive run history", "relive", "reliveRuns", "relive.db (runs)",
                SqliteFiles.number(rl, "SELECT COUNT(*) FROM relive_runs").orElse(0), "runs", historyBytes, 0, 0,
                SqliteFiles.text(rl, "SELECT MIN(started_at) FROM relive_runs"), null, null, false));
        Path scn = files.file("scenarios.db");
        SqliteFiles.FileStats scns = SqliteFiles.stats(scn);
        stores.add(new Store("scenarios", "Resend scenarios", "relive", "work", "scenarios.db",
                SqliteFiles.number(scn, "SELECT COUNT(*) FROM scenarios").orElse(0), "scenarios", scns.totalBytes(), scns.freeBytes(),
                scns.walBytes(), null, null, null, false));
        SqliteFiles.FileStats cm = SqliteFiles.stats(files.file("comments.db"));
        stores.add(new Store("comments", "Comments", "work", "work", "comments.db", safeCount(() -> comments.findAll().size()),
                "comments", cm.totalBytes(), cm.freeBytes(), cm.walBytes(), null, null, null, false));
        long cfgBytes = 0;
        long cfgFree = 0;
        long cfgWal = 0;
        for (String f : List.of("settings.db", "profiles.db", "redactions.db", "interception.db")) {
            SqliteFiles.FileStats s = SqliteFiles.stats(files.file(f));
            cfgBytes += s.totalBytes();
            cfgFree += s.freeBytes();
            cfgWal += s.walBytes();
        }
        stores.add(new Store("config", "Settings & rules", "config", "work",
                "settings.db · profiles.db · redactions.db · interception.db", 0, "", cfgBytes, cfgFree, cfgWal, null, null, null, false));

        long backupBytes = backupBytes();
        if (backupBytes > 0) {
            stores.add(new Store("backups", "Backups", "config", "work", "backups/", backupCount(), "backups", backupBytes, 0, 0,
                    null, null, null, false));
        }

        long used = stores.stream().mapToLong(Store::sizeBytes).sum();
        long freeInside = stores.stream().mapToLong(s -> s.freeBytes() + s.walBytes()).sum();
        Map<String, Long> shareUsed = new LinkedHashMap<>();
        for (String k : StorageBudget.SHARES) {
            shareUsed.put(k, stores.stream().filter(s -> k.equals(s.share())).mapToLong(s -> s.sizeBytes() - s.freeBytes() - s.walBytes()).sum());
        }
        Disk disk = disk();
        long maxBudget = Math.max(StorageBudget.MIN_BYTES, disk.freeBytes() + used - 5 * StorageBudget.GB);
        int warn = budget.rulesOrDefault().lowDiskWarnGb();
        boolean low = warn > 0 && disk.freeBytes() >= 0 && disk.freeBytes() < warn * StorageBudget.GB;
        return new Overview(used, freeInside, disk, budget, shares, shareUsed, maxBudget, stores, reliveRuns(), files.history(), low);
    }

    private long backupBytes() {
        Path dir = files.backupsDir();
        if (!Files.isDirectory(dir)) {
            return 0;
        }
        try (java.util.stream.Stream<Path> s = Files.list(dir)) {
            return s.filter(Files::isRegularFile).mapToLong(p -> {
                try {
                    return Files.size(p);
                } catch (IOException e) {
                    return 0;
                }
            }).sum();
        } catch (IOException e) {
            return 0;
        }
    }

    private long backupCount() {
        try (java.util.stream.Stream<Path> s = Files.list(files.backupsDir())) {
            return s.filter(p -> StorageBackups.NAME.matcher(p.getFileName().toString()).matches()).count();
        } catch (IOException e) {
            return 0;
        }
    }

    private static Long limit(StorageBudget budget, Map<String, Long> shares, String share) {
        return budget.isSet() ? shares.get(share) : null;
    }

    private List<ReliveCycleRuns> reliveRuns() {
        Set<String> starred = files.starredRuns();
        List<ReliveCycleRuns> out = new ArrayList<>();
        for (ReliveCycleSummary c : safeList(reliveCycles::list)) {
            List<RunView> views = safeList(() -> runs.list(c.id(), 500)).stream()
                    .map(r -> new RunView(r.id(), r.status().name(), r.startedAt(), starred.contains(r.id()))).toList();
            out.add(new ReliveCycleRuns(c.id(), c.name(), c.stepCount(), views.isEmpty() ? null : views.get(0).startedAt(), views));
        }
        return out;
    }

    private Disk disk() {
        Path dir = files.dataDir();
        try {
            FileStore store = Files.getFileStore(Files.exists(dir) ? dir : dir.getRoot());
            return new Disk(dir.toString(), store.getUsableSpace(), store.getTotalSpace());
        } catch (IOException | RuntimeException e) {
            return new Disk(dir.toString(), -1, -1);
        }
    }

    // ================================================================== budget

    /** Saves the budget and applies it at once: each slice's limits change and the over-full stores trim now. */
    public Overview saveBudget(StorageBudget requested) {
        StorageBudget budget = requested.validated();
        if (budget.isSet()) {
            Overview now = overview();
            if (budget.bytes() > now.maxBudgetBytes()) {
                throw new IllegalArgumentException("At most " + (now.maxBudgetBytes() / StorageBudget.GB)
                        + " GB fits on this disk and still leaves 5 GB free");
            }
        }
        files.saveBudget(budget);
        if (recordingRules != null) {
            recordingRules.refresh();
        }
        if (commentedKept != null) {
            commentedKept.refresh();
        }
        long before = overview().usedBytes();
        apply(budget);
        trimReliveRuns(budget);
        long after = overview().usedBytes();
        files.addHistory("you", budget.isSet()
                ? "Storage budget set to " + (budget.bytes() / StorageBudget.GB) + " GB (" + budget.split() + " split)"
                : "Storage budget removed - the separate limits apply", Math.max(0, before - after));
        return overview();
    }

    @EventListener(ApplicationReadyEvent.class)
    public void applyAtStart() {
        StorageBudget budget = files.loadBudget();
        if (budget.isSet()) {
            apply(budget);
        }
    }

    /** Each share becomes that slice's own limit; a slice that cannot take one (a legacy file store) is skipped. */
    void apply(StorageBudget budget) {
        if (!budget.isSet()) {
            quietly("db-capture share", () -> captureLimits.setCombinedMaxBytes(0));
            return;
        }
        Map<String, Long> shares = budget.shareBytes();
        quietly("inbound calls", () -> {
            inboundLimits.setRetentionRows(budget.inboundMaxCalls() > 0 ? budget.inboundMaxCalls() : NO_CALL_LIMIT);
            inboundLimits.setMaxSizeBytes(Math.max(MB, shares.get("inbound")));
        });
        quietly("outbound calls", () -> {
            outboundLimits.setMaxRows(budget.outboundMaxCalls());
            outboundLimits.setMaxSizeBytes(Math.max(MB, shares.get("outbound")));
            outboundLimits.trimNow();
        });
        quietly("captured data", () -> captureLimits.setCombinedMaxBytes(Math.max(MB, shares.get("capture"))));
        quietly("logs", () -> applyLogsShare(shares.get("logs")));
    }

    /**
     * Logs: each source keeps an equal part of the logs share (at least 100 MB, the per-source minimum) - lowered,
     * never raised above a smaller limit the source already has. The oldest lines go first as new ones load.
     */
    private void applyLogsShare(long share) {
        List<ManageLogSourcesUseCase.SourceView> sources = logSources.list();
        if (sources.isEmpty()) {
            return;
        }
        long each = Math.max(100 * MB, share / sources.size());
        for (ManageLogSourcesUseCase.SourceView v : sources) {
            long current = v.source().retentionMaxBytes();
            if (current == 0 || current > each) {
                logSources.update(v.source().id(), null, each);
            }
        }
    }

    /** Keeps the newest {@code reliveKeepRuns} runs of each Relive cycle; the cycles, their steps and rules stay. */
    int trimReliveRuns(StorageBudget budget) {
        int keep = budget.reliveKeepRuns();
        if (!budget.isSet() || keep <= 0) {
            return 0;
        }
        int removed = 0;
        for (ReliveCycleSummary c : safeList(reliveCycles::list)) {
            List<Run> list = safeList(() -> runs.list(c.id(), 10_000));
            Set<String> starred = files.starredRuns();
            List<String> old = list.stream().skip(keep).filter(r -> r.status() != RunStatus.RUNNING)
                    .filter(r -> !starred.contains(r.id())).map(Run::id).toList();
            if (!old.isEmpty()) {
                removed += deleteRuns.delete(c.id(), new DeleteRunHistoryCommand(old, true)).runs();
            }
        }
        return removed;
    }

    // ================================================================== free space

    /** {@code running}: still going in the background (a big file on a slow disk) - the history says when it is done. */
    record Compacted(long freedBytes, List<String> files, boolean running) {
    }

    /** A file is worth rewriting when at least this much of it is empty - VACUUM's cost grows with the data it keeps. */
    private static final long WORTH_FREEING = 1024 * 1024;
    static long waitSeconds = 45;
    private final java.util.concurrent.ExecutorService compactor = java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "storage-compact");
        t.setDaemon(true);
        return t;
    });
    private volatile java.util.concurrent.Future<Compacted> compacting;

    /**
     * Gives every file's empty space and write log back to the disk; deletes nothing. Answers within {@link
     * #waitSeconds} - under the gateway's 60 s - and otherwise keeps going in the background (one at a time).
     */
    public Compacted compact(String only) {
        java.util.concurrent.Future<Compacted> job;
        synchronized (this) {
            if (compacting == null || compacting.isDone()) {
                compacting = compactor.submit(() -> compactNow(only));
            }
            job = compacting;
        }
        try {
            return job.get(waitSeconds, java.util.concurrent.TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException e) {
            return new Compacted(0, List.of(), true);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new Compacted(0, List.of(), true);
        } catch (java.util.concurrent.ExecutionException e) {
            throw new IllegalStateException(e.getCause() == null ? e.getMessage() : e.getCause().getMessage(), e);
        }
    }

    @jakarta.annotation.PreDestroy
    void stopCompactor() {
        compactor.shutdownNow();
    }

    private Compacted compactNow(String only) {
        long freed = 0;
        List<String> done = new ArrayList<>();
        for (Map.Entry<String, Path> e : files.all().entrySet()) {
            if (only != null && !only.isBlank() && !only.equals(e.getKey())) {
                continue;
            }
            SqliteFiles.FileStats st = SqliteFiles.stats(e.getValue());
            if (st.freeBytes() + st.walBytes() < WORTH_FREEING) {
                continue;
            }
            // VACUUM writes the data it keeps once more before the old pages go: it needs that much free disk
            long needs = st.fileBytes() - st.freeBytes();
            long diskFree = disk().freeBytes();
            if (diskFree >= 0 && diskFree < needs + 512L * 1024 * 1024) {
                log.warn("Not freeing {}: it needs about {} bytes of free disk while it works, {} are free", e.getKey(), needs, diskFree);
                continue;
            }
            try {
                long f = SqliteFiles.compact(e.getValue());
                freed += f;
                if (f > 0) {
                    done.add(e.getKey());
                }
            } catch (RuntimeException ex) {
                log.warn("{}", ex.getMessage());
            }
        }
        if (freed > 0) {
            files.addHistory("you", "Freed empty space in " + String.join(", ", done) + " - nothing deleted", freed);
        }
        return new Compacted(freed, done, false);
    }

    // ================================================================== clean-up

    /**
     * What a clean-up removes: {@code kind} is inbound, outbound, cycles or reliveRuns; every filter is optional. For
     * reliveRuns, {@code project} names one Relive cycle.
     * {@code keepCommented}: calls with a comment stay.
     */
    record CleanupRequest(String kind, Integer olderThanDays, String project, String status, String urlContains,
                          boolean keepCommented, boolean compactAfter) {
    }

    record CleanupSample(String id, String method, String url, Integer status, String at) {
    }

    /** {@code ids}: the calls themselves (inbound/outbound only), for "Export these first". */
    record CleanupResult(String kind, int count, long bytes, int kept, List<CleanupSample> sample, boolean applied, List<String> ids) {
        CleanupResult(String kind, int count, long bytes, int kept, List<CleanupSample> sample, boolean applied) {
            this(kind, count, bytes, kept, sample, applied, List.of());
        }
    }

    public CleanupResult cleanup(CleanupRequest request, boolean apply) {
        return apply ? manual(() -> cleanupNow(request, true)) : cleanupNow(request, false);
    }

    private CleanupResult cleanupNow(CleanupRequest request, boolean apply) {
        String kind = request.kind() == null ? "" : request.kind();
        String before = request.olderThanDays() == null || request.olderThanDays() <= 0 ? null
                : clock.instant().minus(Duration.ofDays(request.olderThanDays())).toString();
        CleanupResult result = switch (kind) {
            case "inbound" -> calls(request, before, apply, true);
            case "outbound" -> calls(request, before, apply, false);
            case "cycles" -> cycles(before, apply);
            case "reliveRuns" -> runs(before, request.project(), apply);
            default -> throw new IllegalArgumentException("Unknown kind: " + kind);
        };
        if (apply && result.count() > 0) {
            long freed = request.compactAfter() ? compactQuietly(kind) : 0;
            files.addHistory("you", "Deleted " + result.count() + " " + label(kind) + describe(request), freed > 0 ? freed : result.bytes());
        }
        return result;
    }

    private CleanupResult calls(CleanupRequest r, String before, boolean apply, boolean inboundCalls) {
        Set<String> commented = r.keepCommented() ? commentedCallIds() : Set.of();
        List<CleanupSample> sample = new ArrayList<>();
        List<String> ids = new ArrayList<>();
        long bytes = 0;
        int kept = 0;
        if (inboundCalls) {
            var filter = new com.fathy.alfred.backend.internalcalls.domain.model.CleanupFilter(before, r.project(), r.status(), r.urlContains());
            for (var c : inbound.cleanupCandidates(filter, MAX_CLEANUP)) {
                if (commented.contains(c.id())) {
                    kept++;
                    continue;
                }
                ids.add(c.id());
                bytes += c.bytes();
                if (sample.size() < 5) {
                    sample.add(new CleanupSample(c.id(), c.method(), c.url(), c.status(), c.timestamp()));
                }
            }
        } else {
            var filter = new com.fathy.alfred.backend.calls.domain.model.CleanupFilter(before, r.project(), r.status(), r.urlContains());
            for (var c : outbound.cleanupCandidates(filter, MAX_CLEANUP)) {
                if (commented.contains(c.id())) {
                    kept++;
                    continue;
                }
                ids.add(c.id());
                bytes += c.bytes();
                if (sample.size() < 5) {
                    sample.add(new CleanupSample(c.id(), c.method(), c.url(), c.status(), c.timestamp()));
                }
            }
        }
        if (apply) {
            for (int i = 0; i < ids.size(); i += DELETE_CHUNK) {
                List<String> chunk = ids.subList(i, Math.min(ids.size(), i + DELETE_CHUNK));
                if (inboundCalls) {
                    inbound.deleteByIds(chunk);
                } else {
                    outbound.deleteByIds(chunk);
                }
            }
        }
        return new CleanupResult(inboundCalls ? "inbound" : "outbound", ids.size(), bytes, kept, sample, apply, List.copyOf(ids));
    }

    private CleanupResult cycles(String before, boolean apply) {
        List<SessionCycle> victims = safeList(cycles::listAll).stream()
                .filter(c -> c.reliveRunId() == null)
                .filter(c -> before == null || (c.createdAt() != null && c.createdAt().compareTo(before) < 0))
                .toList();
        Store store = overview().stores().stream().filter(s -> s.id().equals("cycles")).findFirst().orElseThrow();
        long each = store.items() == 0 ? 0 : (store.sizeBytes() - store.freeBytes()) / store.items();
        if (apply) {
            victims.forEach(c -> deleteCycle.delete(c.id()));
        }
        List<CleanupSample> sample = victims.stream().limit(5).map(c -> new CleanupSample(c.id(), null, c.name(), null, c.createdAt())).toList();
        return new CleanupResult("cycles", victims.size(), each * victims.size(), 0, sample, apply);
    }

    /** {@code cycleId}: one Relive cycle's runs, or every cycle's when blank. */
    private CleanupResult runs(String before, String cycleId, boolean apply) {
        Set<String> starredRuns = files.starredRuns();
        Map<String, List<String>> byCycle = new LinkedHashMap<>();
        List<CleanupSample> sample = new ArrayList<>();
        int count = 0;
        for (ReliveCycleSummary c : safeList(reliveCycles::list)) {
            if (cycleId != null && !cycleId.isBlank() && !cycleId.equals(c.id())) {
                continue;
            }
            for (Run r : safeList(() -> runs.list(c.id(), 10_000))) {
                if (r.status() == RunStatus.RUNNING || starredRuns.contains(r.id())
                        || (before != null && (r.startedAt() == null || r.startedAt().compareTo(before) >= 0))) {
                    continue;
                }
                byCycle.computeIfAbsent(c.id(), k -> new ArrayList<>()).add(r.id());
                count++;
                if (sample.size() < 5) {
                    sample.add(new CleanupSample(r.id(), null, c.name(), null, r.startedAt()));
                }
            }
        }
        List<Store> all = overview().stores();
        long runCount = all.stream().filter(s -> s.id().equals("reliveHistory")).mapToLong(Store::items).sum();
        long bytes = all.stream().filter(s -> s.id().equals("reliveRuns") || s.id().equals("reliveHistory")).mapToLong(Store::sizeBytes).sum();
        long each = runCount == 0 ? 0 : bytes / runCount;
        if (apply) {
            byCycle.forEach((cycle, ids) -> deleteRuns.delete(cycle, new DeleteRunHistoryCommand(ids, true)));
        }
        return new CleanupResult("reliveRuns", count, each * count, 0, sample, apply);
    }

    /** Deletes every inbound call (the "clear inbound" action); their captures go with them. */
    public int clearInbound() {
        long n = safeCount(() -> inbound.statusBreakdown().total());
        manual(() -> {
            inbound.deleteAll();
            return null;
        });
        files.addHistory("you", "Deleted all " + n + " inbound calls", -1);
        return (int) n;
    }

    /** Deletes every session cycle you recorded; Relive run recordings stay (they go with their run's history). */
    public int clearUserCycles() {
        List<SessionCycle> mine = safeList(cycles::listAll).stream().filter(c -> c.reliveRunId() == null).toList();
        mine.forEach(c -> deleteCycle.delete(c.id()));
        files.addHistory("you", "Deleted all " + mine.size() + " session cycles", -1);
        return mine.size();
    }

    /** Deletes exactly these calls ("Delete these" on the Biggest tab); a call with a comment stays. */
    record DeleteRequest(List<String> inbound, List<String> outbound, String what) {
    }

    record Deleted(int count, int kept) {
    }

    public Deleted deleteCalls(DeleteRequest request) {
        Set<String> commented = commentedCallIds();
        List<String> in = request.inbound() == null ? List.of() : request.inbound().stream().filter(id -> !commented.contains(id)).toList();
        List<String> out = request.outbound() == null ? List.of() : request.outbound().stream().filter(id -> !commented.contains(id)).toList();
        int asked = (request.inbound() == null ? 0 : request.inbound().size()) + (request.outbound() == null ? 0 : request.outbound().size());
        int count = manual(() -> {
            int n = 0;
            for (int i = 0; i < in.size(); i += DELETE_CHUNK) {
                n += inbound.deleteByIds(in.subList(i, Math.min(in.size(), i + DELETE_CHUNK)));
            }
            for (int i = 0; i < out.size(); i += DELETE_CHUNK) {
                n += outbound.deleteByIds(out.subList(i, Math.min(out.size(), i + DELETE_CHUNK)));
            }
            return n;
        });
        if (count > 0) {
            files.addHistory("you", "Deleted " + count + " calls"
                    + (request.what() == null || request.what().isBlank() ? "" : " - " + request.what()), -1);
        }
        return new Deleted(count, asked - in.size() - out.size());
    }

    /** A starred run is never deleted by a rule or a clean-up - only by "Delete runs" on its own cycle. */
    public void star(String runId, boolean starred) {
        if (runId == null || runId.isBlank()) {
            throw new IllegalArgumentException("No run");
        }
        files.setStarred(runId, starred);
    }

    record FileHealth(String name, long fileBytes, long walBytes, long freeBytes, String check) {
    }

    /** Every store file's size, write log and empty space; {@code check} runs SQLite's quick_check on each. */
    public List<FileHealth> files(boolean check) {
        List<FileHealth> out = new ArrayList<>();
        for (Map.Entry<String, Path> e : files.all().entrySet()) {
            SqliteFiles.FileStats st = SqliteFiles.stats(e.getValue());
            if (st == SqliteFiles.FileStats.MISSING) {
                continue;
            }
            out.add(new FileHealth(e.getKey(), st.fileBytes(), st.walBytes(), st.freeBytes(), check ? SqliteFiles.quickCheck(e.getValue()) : null));
        }
        return out;
    }

    /** Folds every write log into its file; deletes nothing. */
    public long checkpointAll() {
        long freed = 0;
        for (Path p : files.all().values()) {
            try {
                freed += SqliteFiles.checkpoint(p);
            } catch (RuntimeException e) {
                log.warn("{}", e.getMessage());
            }
        }
        if (freed > 0) {
            files.addHistory("you", "Folded the write logs into their files", freed);
        }
        return freed;
    }

    // ================================================================== automatic rules

    /**
     * Every 10 minutes: drop CORS preflights and health checks when those rules are on, and guard the disk - under
     * its limit the oldest traffic goes (inbound first, then outbound) until 5 GB more is free. Your work never.
     */
    @Scheduled(fixedDelay = 600_000, initialDelay = 120_000)
    public void sweepOften() {
        StorageBudget.Rules rules = files.loadBudget().rulesOrDefault();
        if (rules.dropPreflights()) {
            for (String kind : List.of("inbound", "outbound")) {
                CleanupResult r = quietlyGet(() -> manual(() -> calls(new CleanupRequest(kind, null, null, "options", null, true, false),
                        null, true, "inbound".equals(kind))));
                if (r != null && r.count() > 0) {
                    files.addHistory("auto", r.count() + " " + label(kind) + " that were CORS preflights removed", r.bytes());
                }
            }
        }
        for (String part : rules.healthPaths() == null ? new String[0] : rules.healthPaths().split(",")) {
            String p = part.trim();
            if (p.isEmpty()) {
                continue;
            }
            for (String kind : List.of("inbound", "outbound")) {
                CleanupResult r = quietlyGet(() -> manual(() -> calls(new CleanupRequest(kind, null, null, null, p, true, false),
                        null, true, "inbound".equals(kind))));
                if (r != null && r.count() > 0) {
                    files.addHistory("auto", r.count() + " " + label(kind) + " to " + p + " (health checks) removed", r.bytes());
                }
            }
        }
        guardDisk(rules);
    }

    void guardDisk(StorageBudget.Rules rules) {
        if (rules.diskGuardGb() <= 0) {
            return;
        }
        long limit = rules.diskGuardGb() * StorageBudget.GB;
        long target = limit + 5 * StorageBudget.GB;
        if (disk().freeBytes() < 0 || disk().freeBytes() >= limit) {
            return;
        }
        int removed = 0;
        for (boolean inboundCalls : new boolean[] {true, false}) {
            while (disk().freeBytes() < target) {
                List<String> oldest = (inboundCalls
                        ? inbound.cleanupCandidates(new com.fathy.alfred.backend.internalcalls.domain.model.CleanupFilter(null, null, null, null), 500)
                                .stream().map(c -> c.id()).toList()
                        : outbound.cleanupCandidates(new com.fathy.alfred.backend.calls.domain.model.CleanupFilter(null, null, null, null), 500)
                                .stream().map(c -> c.id()).toList());
                Set<String> commented = commentedCallIds();
                List<String> victims = oldest.stream().filter(id -> !commented.contains(id)).toList();
                if (victims.isEmpty()) {
                    break;
                }
                removed += manual(() -> inboundCalls ? inbound.deleteByIds(victims) : outbound.deleteByIds(victims));
                compactQuietly(inboundCalls ? "inbound" : "outbound");
            }
        }
        if (removed > 0) {
            files.addHistory("auto", removed + " oldest calls removed - the disk was under " + rules.diskGuardGb() + " GB free", -1);
            log.warn("Disk guard: removed {} oldest calls, the disk was under {} GB free", removed, rules.diskGuardGb());
        }
    }

    /** Nightly: free the empty space of any file more than 20% empty, when that rule is on. */
    @Scheduled(cron = "0 30 2 * * *")
    public void nightlyCompact() {
        if (!files.loadBudget().rulesOrDefault().autoCompact()) {
            return;
        }
        boolean worth = files.all().values().stream().map(SqliteFiles::stats)
                .anyMatch(st -> st.fileBytes() > 0 && st.freeBytes() + st.walBytes() > 0.2 * st.fileBytes() && st.freeBytes() > WORTH_FREEING);
        if (worth) {
            Compacted c = quietlyGet(() -> compactNow(null));
            if (c != null && c.freedBytes() > 0) {
                files.addHistory("auto", "Freed empty space at night in " + String.join(", ", c.files()), c.freedBytes());
            }
        }
    }

    /** Hourly: the age rules ("also delete after N days") and the Relive keep-last-N. */
    @Scheduled(fixedDelay = 3_600_000, initialDelay = 300_000)
    public void sweep() {
        StorageBudget budget = files.loadBudget();
        if (!budget.isSet()) {
            return;
        }
        for (String kind : List.of("inbound", "outbound")) {
            int days = budget.ageDays(kind);
            if (days > 0) {
                CleanupResult done = quietlyGet(() -> calls(new CleanupRequest(kind, days, null, null, null, true, false),
                        clock.instant().minus(Duration.ofDays(days)).toString(), true, "inbound".equals(kind)));
                if (done != null && done.count() > 0) {
                    files.addHistory("auto", done.count() + " " + label(kind) + " older than " + days + " days removed", done.bytes());
                }
            }
        }
        int runDays = budget.ageDays("reliveRuns");
        if (runDays > 0) {
            CleanupResult done = quietlyGet(() -> runs(clock.instant().minus(Duration.ofDays(runDays)).toString(), null, true));
            if (done != null && done.count() > 0) {
                files.addHistory("auto", done.count() + " Relive runs older than " + runDays + " days removed", done.bytes());
            }
        }
        Integer trimmed = quietlyGet(() -> trimReliveRuns(budget));
        if (trimmed != null && trimmed > 0) {
            files.addHistory("auto", trimmed + " Relive runs beyond the last " + budget.reliveKeepRuns() + " per cycle removed", -1);
        }
    }

    // ================================================================== helpers

    /** Calls every clean-up keeps: with a comment, and - through the same rule - those a Relive step or stored answer came from. */
    private Set<String> commentedCallIds() {
        Set<String> ids = fromComments();
        if (commentedKept != null) {
            ids.addAll(commentedKept.referenced());
        }
        return ids;
    }

    private Set<String> fromComments() {
        Set<String> ids = new HashSet<>();
        safeList(comments::findAll).forEach(c -> {
            if (c.callId() != null) {
                ids.add(c.callId());
            }
        });
        return ids;
    }

    private long compactQuietly(String kind) {
        String file = switch (kind) {
            case "inbound" -> "internal-calls.db";
            case "outbound" -> "calls.db";
            default -> "session-cycles.db";
        };
        try {
            return SqliteFiles.compact(files.file(file)) + ("inbound".equals(kind) ? SqliteFiles.compact(files.file("db-capture.db")) : 0);
        } catch (RuntimeException e) {
            log.warn("{}", e.getMessage());
            return 0;
        }
    }

    private static String label(String kind) {
        return switch (kind) {
            case "inbound" -> "inbound calls";
            case "outbound" -> "outbound calls";
            case "cycles" -> "session cycles";
            default -> "Relive runs";
        };
    }

    private static String describe(CleanupRequest r) {
        List<String> parts = new ArrayList<>();
        if (r.olderThanDays() != null && r.olderThanDays() > 0) {
            parts.add("older than " + r.olderThanDays() + " days");
        }
        if (r.project() != null && !r.project().isBlank()) {
            parts.add(r.project());
        }
        if (r.status() != null && !r.status().isBlank()) {
            parts.add(r.status());
        }
        if (r.urlContains() != null && !r.urlContains().isBlank()) {
            parts.add("URL contains \"" + r.urlContains() + "\"");
        }
        return parts.isEmpty() ? "" : " (" + String.join(", ", parts) + ")";
    }

    private static long safeCount(java.util.function.LongSupplier s) {
        try {
            return s.getAsLong();
        } catch (RuntimeException e) {
            return 0;
        }
    }

    private static String safeText(java.util.function.Supplier<Optional<String>> s) {
        try {
            return s.get().orElse(null);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static <T> List<T> safeList(java.util.function.Supplier<List<T>> s) {
        try {
            List<T> list = s.get();
            return list == null ? List.of() : list;
        } catch (RuntimeException e) {
            log.debug("Storage overview: {}", e.getMessage());
            return List.of();
        }
    }

    private static void quietly(String what, Runnable r) {
        try {
            r.run();
        } catch (RuntimeException e) {
            log.warn("Storage budget: could not apply the {} share: {}", what, e.getMessage());
        }
    }

    private static <T> T quietlyGet(java.util.function.Supplier<T> s) {
        try {
            return s.get();
        } catch (RuntimeException e) {
            log.warn("Storage rules: {}", e.getMessage());
            return null;
        }
    }
}
