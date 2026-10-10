package com.fathy.alfred.backend.storage;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Clock;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * Settings → Storage's "Backup & files": a .zip of chosen groups of stores, written into {@code data/backups} (each
 * file copied consistently with {@code VACUUM INTO}, safe while Alfred records), downloadable from the page, made
 * nightly for your work if asked, and restored by choosing one: its files wait in {@code data/restore-pending} and
 * replace the live ones at the next start, before any store opens ({@link StagedRestore}) - a running store's file
 * is never swapped under it. The replaced files are kept in {@code data/restore-replaced}.
 */
@Service
public class StorageBackups {

    private static final Logger log = LoggerFactory.getLogger(StorageBackups.class);
    static final Map<String, List<String>> GROUPS = groups();
    static final Pattern NAME = Pattern.compile("alfred-(backup|nightly)-[0-9]{8}-[0-9]{6}\\.zip");
    static final String READY = "READY";
    static final int NIGHTLY_KEPT = 7;
    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneOffset.UTC);

    private final StorageFiles files;
    private final ObjectMapper json = new ObjectMapper();
    private final Clock clock;

    public StorageBackups(StorageFiles files, Optional<Clock> clock) {
        this.files = files;
        this.clock = clock.orElse(Clock.systemUTC());
    }

    private static Map<String, List<String>> groups() {
        Map<String, List<String>> g = new LinkedHashMap<>();
        g.put("traffic", List.of("calls.db", "internal-calls.db", "db-capture.db", "triage.db"));
        g.put("work", List.of("session-cycles.db", "comments.db", "relive.db", "scenarios.db"));
        g.put("config", List.of("settings.db", "profiles.db", "redactions.db", "interception.db"));
        g.put("logs", List.of("logs.db"));
        return java.util.Collections.unmodifiableMap(g);
    }

    record Backup(String name, long bytes, String at, List<String> files, boolean nightly) {
    }

    record Pending(List<String> files, String from) {
    }

    record Backups(String dataDir, List<Backup> backups, Pending pending) {
    }

    public Backups list() {
        List<Backup> out = new ArrayList<>();
        Path dir = files.backupsDir();
        if (Files.isDirectory(dir)) {
            try (Stream<Path> s = Files.list(dir)) {
                for (Path p : s.filter(p -> NAME.matcher(p.getFileName().toString()).matches()).toList()) {
                    out.add(new Backup(p.getFileName().toString(), Files.size(p), Files.getLastModifiedTime(p).toInstant().toString(),
                            entries(p), p.getFileName().toString().startsWith("alfred-nightly-")));
                }
            } catch (IOException e) {
                log.warn("Could not list {}: {}", dir, e.getMessage());
            }
        }
        out.sort(Comparator.comparing(Backup::at).reversed());
        return new Backups(files.dataDir().toString(), out, pending());
    }

    private final java.util.concurrent.ExecutorService worker = java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "storage-backup");
        t.setDaemon(true);
        return t;
    });
    private volatile java.util.concurrent.Future<Backup> running;

    /**
     * The page's "Back up now": answers within {@code waitSeconds} (under the gateway's 60 s) with the backup, or
     * with empty while a big one keeps going in the background - one at a time.
     */
    public Optional<Backup> backUpWithin(List<String> groups, long waitSeconds) {
        java.util.concurrent.Future<Backup> job;
        synchronized (this) {
            if (running == null || running.isDone()) {
                running = worker.submit(() -> backUp(groups, false));
            }
            job = running;
        }
        try {
            return Optional.of(job.get(waitSeconds, java.util.concurrent.TimeUnit.SECONDS));
        } catch (java.util.concurrent.TimeoutException e) {
            return Optional.empty();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Optional.empty();
        } catch (java.util.concurrent.ExecutionException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            throw cause instanceof RuntimeException r ? r : new IllegalStateException(cause.getMessage(), cause);
        }
    }

    @jakarta.annotation.PreDestroy
    void stopWorker() {
        worker.shutdownNow();
    }

    /** Writes a backup of these groups (traffic, work, config, logs) into data/backups and returns it. */
    public Backup backUp(List<String> groups, boolean nightly) {
        List<String> names = new ArrayList<>();
        for (String g : groups == null || groups.isEmpty() ? List.of("work", "config") : groups) {
            List<String> members = GROUPS.get(g);
            if (members == null) {
                throw new IllegalArgumentException("Unknown group: " + g);
            }
            names.addAll(members);
        }
        Path dir = files.backupsDir();
        String name = "alfred-" + (nightly ? "nightly" : "backup") + "-" + STAMP.format(clock.instant()) + ".zip";
        Path target = dir.resolve(name);
        Path tmpDir = dir.resolve(".work");
        try {
            Files.createDirectories(tmpDir);
            Path partial = dir.resolve(name + ".part");
            List<String> included = new ArrayList<>();
            try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(partial))) {
                for (String file : names) {
                    Path source = files.file(file);
                    if (source == null || !Files.isRegularFile(source)) {
                        continue;
                    }
                    Path copy = tmpDir.resolve(file);
                    SqliteFiles.copyTo(source, copy);
                    zip.putNextEntry(new ZipEntry(file));
                    Files.copy(copy, zip);
                    zip.closeEntry();
                    Files.deleteIfExists(copy);
                    included.add(file);
                }
                zip.putNextEntry(new ZipEntry("manifest.json"));
                zip.write(json.writeValueAsBytes(Map.of("at", clock.instant().toString(), "groups", groups == null ? List.of() : groups,
                        "files", included)));
                zip.closeEntry();
            }
            Files.move(partial, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            Files.deleteIfExists(tmpDir);
            files.addHistory(nightly ? "auto" : "you", "Backed up " + String.join(", ", included) + " to " + name, -1);
            return new Backup(name, Files.size(target), clock.instant().toString(), included, nightly);
        } catch (IOException e) {
            throw new IllegalStateException("Could not write the backup: " + e.getMessage(), e);
        }
    }

    static final Pattern UPLOAD_ID = Pattern.compile("[a-f0-9-]{8,64}");
    static final long MAX_UPLOAD = 200L * 1024 * 1024 * 1024;

    /**
     * One chunk of a backup .zip uploaded from the page (chunks keep each request under the gateway's body limit).
     * Written at {@code offset} of a part file; the last chunk checks the zip holds Alfred store files and makes it an
     * ordinary backup in data/backups, ready to restore. Empty until the last chunk arrives.
     */
    public synchronized Optional<Backup> receiveChunk(String uploadId, long offset, long total, InputStream body) {
        if (uploadId == null || !UPLOAD_ID.matcher(uploadId).matches() || offset < 0 || total <= 0 || total > MAX_UPLOAD) {
            throw new IllegalArgumentException("Not a valid upload");
        }
        Path dir = files.backupsDir();
        Path part = dir.resolve(".upload-" + uploadId + ".part");
        try {
            Files.createDirectories(dir);
            if (offset == 0) {
                Files.deleteIfExists(part);
            } else if (!Files.isRegularFile(part) || Files.size(part) != offset) {
                throw new IllegalArgumentException("Chunks out of order - start the upload again");
            }
            try (OutputStream out = Files.newOutputStream(part, java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND)) {
                body.transferTo(out);
            }
            long size = Files.size(part);
            if (size > total) {
                Files.deleteIfExists(part);
                throw new IllegalArgumentException("The upload is larger than announced");
            }
            if (size < total) {
                return Optional.empty();
            }
            List<String> stores = entries(part);
            List<String> known = GROUPS.values().stream().flatMap(List::stream).toList();
            if (stores.stream().noneMatch(known::contains)) {
                Files.deleteIfExists(part);
                throw new IllegalArgumentException("This file is not an Alfred backup - it holds no store files");
            }
            String name = "alfred-backup-" + STAMP.format(clock.instant()) + ".zip";
            Path target = dir.resolve(name);
            Files.move(part, target, StandardCopyOption.REPLACE_EXISTING);
            files.addHistory("you", "Uploaded backup " + name + " (" + String.join(", ", stores) + ")", -1);
            return Optional.of(new Backup(name, Files.size(target), clock.instant().toString(), stores, false));
        } catch (IOException e) {
            throw new IllegalStateException("Could not save the upload: " + e.getMessage(), e);
        }
    }

    /** The backup's bytes, for the page's download link. */
    public Path file(String name) {
        if (name == null || !NAME.matcher(name).matches()) {
            throw new IllegalArgumentException("Not a backup: " + name);
        }
        Path p = files.backupsDir().resolve(name);
        if (!Files.isRegularFile(p)) {
            throw new IllegalArgumentException("No such backup: " + name);
        }
        return p;
    }

    public void delete(String name) throws IOException {
        Files.delete(file(name));
    }

    /** Prepares a restore: the backup's files wait for the next start, then replace the live ones. */
    public Pending stageRestore(String name) {
        Path zipFile = file(name);
        Path dir = files.restoreDir();
        try {
            clearPending();
            Files.createDirectories(dir);
            List<String> staged = new ArrayList<>();
            List<String> known = GROUPS.values().stream().flatMap(List::stream).toList();
            try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(zipFile))) {
                ZipEntry e;
                while ((e = zip.getNextEntry()) != null) {
                    // only the store files Alfred knows, by name - never a path from inside the zip
                    if (!known.contains(e.getName())) {
                        continue;
                    }
                    Files.copy(zip, dir.resolve(e.getName()), StandardCopyOption.REPLACE_EXISTING);
                    staged.add(e.getName());
                }
            }
            if (staged.isEmpty()) {
                clearPending();
                throw new IllegalArgumentException(name + " holds no Alfred store files");
            }
            Files.writeString(dir.resolve(READY), name);
            files.addHistory("you", "Restore of " + name + " prepared (" + String.join(", ", staged) + ") - applies at the next start", -1);
            return new Pending(staged, name);
        } catch (IOException e) {
            throw new IllegalStateException("Could not prepare the restore: " + e.getMessage(), e);
        }
    }

    public void cancelRestore() {
        clearPending();
    }

    Pending pending() {
        Path dir = files.restoreDir();
        Path ready = dir.resolve(READY);
        if (!Files.isRegularFile(ready)) {
            return null;
        }
        try (Stream<Path> s = Files.list(dir)) {
            List<String> staged = s.map(p -> p.getFileName().toString()).filter(n -> !READY.equals(n)).sorted().toList();
            return new Pending(staged, Files.readString(ready).trim());
        } catch (IOException e) {
            return null;
        }
    }

    private void clearPending() {
        Path dir = files.restoreDir();
        if (!Files.isDirectory(dir)) {
            return;
        }
        try (Stream<Path> s = Files.list(dir)) {
            for (Path p : s.toList()) {
                Files.deleteIfExists(p);
            }
            Files.deleteIfExists(dir);
        } catch (IOException e) {
            log.warn("Could not clear {}: {}", dir, e.getMessage());
        }
    }

    private List<String> entries(Path zipFile) {
        List<String> out = new ArrayList<>();
        try (InputStream in = Files.newInputStream(zipFile); ZipInputStream zip = new ZipInputStream(in)) {
            ZipEntry e;
            while ((e = zip.getNextEntry()) != null) {
                if (e.getName().endsWith(".db")) {
                    out.add(e.getName());
                }
            }
        } catch (IOException e) {
            // an unreadable zip lists no files
        }
        return out;
    }

    /** Nightly, when asked: your work and setup, the last {@link #NIGHTLY_KEPT} kept. */
    @Scheduled(cron = "0 0 3 * * *")
    public void nightly() {
        if (!files.loadBudget().rulesOrDefault().nightlyBackup()) {
            return;
        }
        try {
            backUp(List.of("work", "config"), true);
            List<Backup> nightly = list().backups().stream().filter(Backup::nightly).toList();
            for (Backup old : nightly.subList(Math.min(NIGHTLY_KEPT, nightly.size()), nightly.size())) {
                Files.deleteIfExists(files.backupsDir().resolve(old.name()));
            }
        } catch (RuntimeException | IOException e) {
            log.warn("Nightly backup failed: {}", e.getMessage());
        }
    }

    static void stream(Path file, OutputStream out) throws IOException {
        Files.copy(file, out);
    }
}
