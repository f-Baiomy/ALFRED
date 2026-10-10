package com.fathy.alfred.backend.storage;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Where every store's file is, and the storage page's own two small files next to them: the budget
 * ({@code storage-budget.json}, written atomically) and the clean-up history ({@code storage-history.json}, the last
 * {@link #HISTORY_KEPT} entries). Neither is in a database: the budget must be readable before any store opens.
 */
@Component
class StorageFiles {

    private static final Logger log = LoggerFactory.getLogger(StorageFiles.class);
    static final int HISTORY_KEPT = 200;

    private final ObjectMapper json = new ObjectMapper();
    private final Map<String, Path> files = new LinkedHashMap<>();
    private final Path dataDir;

    /** For tests: board.db next to calls.db. */
    StorageFiles(String calls, String internalCalls, String dbCapture, String logs, String triage, String sessionCycles,
                 String comments, String relive, String scenarios, String settings, String profiles, String redactions,
                 String interception) {
        this(calls, internalCalls, dbCapture, logs, triage, sessionCycles, comments, relive, scenarios, settings, profiles,
                redactions, interception, siblingOf(calls, "board.db"));
    }

    @org.springframework.beans.factory.annotation.Autowired
    StorageFiles(@Value("${CALLS_DB_FILE:/appdata/calls.db}") String calls,
                 @Value("${INTERNAL_CALLS_DB_FILE:/appdata/internal-calls.db}") String internalCalls,
                 @Value("${DB_CAPTURE_DB_FILE:/appdata/db-capture.db}") String dbCapture,
                 @Value("${LOGS_DB_FILE:/appdata/logs.db}") String logs,
                 @Value("${TRIAGE_DB_FILE:/appdata/triage.db}") String triage,
                 @Value("${SESSION_CYCLES_DB_FILE:/appdata/session-cycles.db}") String sessionCycles,
                 @Value("${COMMENTS_DB_FILE:/appdata/comments.db}") String comments,
                 @Value("${RELIVE_DB_FILE:/appdata/relive.db}") String relive,
                 @Value("${SCENARIOS_DB_FILE:/appdata/scenarios.db}") String scenarios,
                 @Value("${FILTER_SETTINGS_DB_FILE:/appdata/settings.db}") String settings,
                 @Value("${PROFILES_DB_FILE:/appdata/profiles.db}") String profiles,
                 @Value("${REDACTIONS_DB_FILE:/appdata/redactions.db}") String redactions,
                 @Value("${INTERCEPTION_DB_FILE:/appdata/interception.db}") String interception,
                 @Value("${BOARD_DB_FILE:/appdata/board.db}") String board) {
        files.put("calls.db", Paths.get(calls));
        files.put("internal-calls.db", Paths.get(internalCalls));
        files.put("db-capture.db", Paths.get(dbCapture));
        files.put("logs.db", Paths.get(logs));
        files.put("triage.db", Paths.get(triage));
        files.put("session-cycles.db", Paths.get(sessionCycles));
        files.put("comments.db", Paths.get(comments));
        files.put("relive.db", Paths.get(relive));
        files.put("scenarios.db", Paths.get(scenarios));
        files.put("settings.db", Paths.get(settings));
        files.put("profiles.db", Paths.get(profiles));
        files.put("redactions.db", Paths.get(redactions));
        files.put("interception.db", Paths.get(interception));
        files.put("board.db", Paths.get(board));
        Path parent = Paths.get(calls).toAbsolutePath().getParent();
        this.dataDir = parent == null ? Paths.get(".").toAbsolutePath() : parent;
    }

    private static String siblingOf(String file, String name) {
        Path parent = Paths.get(file).toAbsolutePath().getParent();
        return (parent == null ? Paths.get(name) : parent.resolve(name)).toString();
    }

    Path file(String name) {
        return files.get(name);
    }

    Map<String, Path> all() {
        return files;
    }

    Path dataDir() {
        return dataDir;
    }

    // ------------------------------------------------------------------ budget

    synchronized StorageBudget loadBudget() {
        Path file = dataDir.resolve("storage-budget.json");
        if (!Files.isRegularFile(file)) {
            return StorageBudget.NONE;
        }
        try {
            return json.readValue(file.toFile(), StorageBudget.class).validated();
        } catch (IOException | RuntimeException e) {
            log.warn("storage-budget.json could not be read ({}); the separate limits apply", e.getMessage());
            return StorageBudget.NONE;
        }
    }

    synchronized void saveBudget(StorageBudget budget) {
        writeAtomically(dataDir.resolve("storage-budget.json"), budget);
    }

    // ------------------------------------------------------------------ history

    /** One clean-up: who ("auto" or "you"), what, and the bytes it gave back (-1 when not measured). */
    record HistoryEntry(String at, String who, String what, long bytes) {
    }

    synchronized List<HistoryEntry> history() {
        Path file = dataDir.resolve("storage-history.json");
        if (!Files.isRegularFile(file)) {
            return List.of();
        }
        try {
            return json.readValue(file.toFile(), new TypeReference<List<HistoryEntry>>() { });
        } catch (IOException e) {
            return List.of();
        }
    }

    synchronized void addHistory(String who, String what, long bytes) {
        List<HistoryEntry> entries = new ArrayList<>();
        entries.add(new HistoryEntry(Instant.now().toString(), who, what, bytes));
        entries.addAll(history());
        writeAtomically(dataDir.resolve("storage-history.json"), entries.subList(0, Math.min(HISTORY_KEPT, entries.size())));
    }

    // ------------------------------------------------------------------ starred Relive runs

    /** Runs the user starred on the storage page: no rule, clean-up or "last N" ever deletes them. */
    synchronized java.util.Set<String> starredRuns() {
        Path file = dataDir.resolve("storage-starred-runs.json");
        if (!Files.isRegularFile(file)) {
            return java.util.Set.of();
        }
        try {
            return java.util.Set.copyOf(json.readValue(file.toFile(), new TypeReference<List<String>>() { }));
        } catch (IOException e) {
            return java.util.Set.of();
        }
    }

    synchronized void setStarred(String runId, boolean starred) {
        java.util.Set<String> next = new java.util.TreeSet<>(starredRuns());
        if (starred) {
            next.add(runId);
        } else {
            next.remove(runId);
        }
        writeAtomically(dataDir.resolve("storage-starred-runs.json"), List.copyOf(next));
    }

    // ------------------------------------------------------------------ backups

    Path backupsDir() {
        return dataDir.resolve("backups");
    }

    /** Where a chosen backup's files wait for the next start (applied before any store opens - StagedRestore). */
    Path restoreDir() {
        return dataDir.resolve("restore-pending");
    }

    private void writeAtomically(Path target, Object value) {
        try {
            Files.createDirectories(target.getParent());
            Path tmp = target.resolveSibling(target.getFileName() + ".tmp");
            Files.writeString(tmp, json.writerWithDefaultPrettyPrinter().writeValueAsString(value), StandardCharsets.UTF_8);
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            throw new IllegalStateException("Could not write " + target.getFileName() + ": " + e.getMessage(), e);
        }
    }
}
