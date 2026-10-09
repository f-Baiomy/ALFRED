package com.fathy.alfred.backend.server.application.service;

import com.fathy.alfred.backend.server.application.port.out.MachinePort;
import com.fathy.alfred.backend.server.application.port.out.StorageStatsPort;
import com.fathy.alfred.backend.server.domain.model.Project;
import com.fathy.alfred.backend.server.domain.model.ServicesGrammar;
import com.fathy.alfred.backend.server.domain.model.SettingsValidator;
import com.fathy.alfred.backend.server.domain.model.ValidationResult;
import com.fathy.alfred.backend.server.domain.model.WatchedFolder;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;

/**
 * The checks that need the machine (data-model "Validation rules by kind", FR-030/032): a port in use and by whom, a
 * folder that does not exist, a size cap below what is stored or above the free disk, memory above the free RAM, a
 * project's app not answering. ERROR blocks a save; app health and the size/memory warnings never do.
 *
 * <p>One check request stops probing after {@value #BUDGET_MILLIS} ms (Constitution I: bounded work per request);
 * whatever was not reached is reported as a WARNING "check timed out".
 */
public class MachineProbes extends SettingsProbes {

    static final long BUDGET_MILLIS = 5_000;
    /** Memory per retained inbound call, as measured for the ring buffer (CLAUDE.md: ~28 KB per real call). */
    static final long BYTES_PER_INBOUND_CALL = 28 * 1024;
    private static final List<String> SIZE_KEYS = List.of(
            "ALFRED_CALLS_MAX_SIZE_BYTES", "INTERNAL_CALLS_MAX_SIZE_BYTES", "ALFRED_DB_CAPTURE_MAX_SIZE_BYTES",
            "ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES");

    private final MachinePort machine;
    private final StorageStatsPort storage;
    private final Supplier<Map<String, String>> running;
    private final Path home;

    /**
     * @param running the settings the running processes use now (a port they hold is not "in use by another process")
     * @param home    the install folder, against which "./name" paths are resolved
     */
    public MachineProbes(MachinePort machine, StorageStatsPort storage, Supplier<Map<String, String>> running, Path home) {
        this.machine = machine;
        this.storage = storage;
        this.running = running;
        this.home = home;
    }

    @Override
    public List<ValidationResult> check(Map<String, String> effective, Set<String> keys) {
        long deadline = System.currentTimeMillis() + BUDGET_MILLIS;
        Map<String, String> now = running.get();
        List<ValidationResult> out = new ArrayList<>();
        for (String key : keys) {
            if (System.currentTimeMillis() > deadline) {
                out.add(ValidationResult.warning(key, "check timed out"));
                continue;
            }
            String value = effective.getOrDefault(key, "");
            try {
                switch (key) {
                    case "ALFRED_UI_PORT" -> port(key, value, now, out);
                    case "ALFRED_OUTBOUND_PROXY_LISTEN" -> outboundListen(key, value, now, out);
                    case "INTERNAL_CALL_SERVICES" -> projects(key, value, now, out, deadline);
                    case "ALFRED_LOGS_DIR", "WILDFLY_HOME" -> folder(key, value, out);
                    case "ALFRED_LOGS_WATCH_DIRS" -> folders(key, value, out);
                    case "ALFRED_CALLS_MAX_SIZE_BYTES", "INTERNAL_CALLS_MAX_SIZE_BYTES", "ALFRED_DB_CAPTURE_MAX_SIZE_BYTES",
                         "ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES" ->
                            size(key, value, effective, out);
                    case "ALFRED_MEMORY" -> memory(key, value, out);
                    case "INTERNAL_CALLS_RETENTION_ROWS" -> retention(key, value, effective, out);
                    default -> { }
                }
            } catch (SettingsValidator.InvalidValue | IllegalArgumentException e) {
                // the format rule already reports it (a bad number, a port out of range)
            }
        }
        return out;
    }

    private void port(String key, String value, Map<String, String> now, List<ValidationResult> out) {
        int port = Integer.parseInt(value);
        if (value.equals(now.get(key))) {
            out.add(ValidationResult.ok(key, "in use by Alfred itself"));
            return;
        }
        machine.portOwner(port).ifPresentOrElse(
                owner -> out.add(ValidationResult.error(key, "port " + port + " is in use by " + owner).with(Map.of("process", owner))),
                () -> out.add(ValidationResult.ok(key, port + " is free")));
    }

    private void outboundListen(String key, String value, Map<String, String> now, List<ValidationResult> out) {
        if (value.equals(now.get(key))) {
            out.add(ValidationResult.ok(key, "in use by Alfred's outbound proxy"));
            return;
        }
        int port = Integer.parseInt(value.substring(value.lastIndexOf(':') + 1));
        machine.portOwner(port).ifPresent(owner ->
                out.add(ValidationResult.warning(key, "port " + port + " is in use by " + owner + " (fine if it listens on another address)")
                        .with(Map.of("process", owner))));
    }

    private void projects(String key, String value, Map<String, String> now, List<ValidationResult> out, long deadline) {
        Set<Integer> ours = new HashSet<>();
        ServicesGrammar.parseProjects(now.getOrDefault(key, "")).forEach(p -> ours.add(p.listenPort()));
        Map<String, Object> health = new LinkedHashMap<>();
        for (Project p : ServicesGrammar.parseProjects(value)) {
            if (!ours.contains(p.listenPort())) {
                machine.portOwner(p.listenPort()).ifPresent(owner -> out.add(
                        ValidationResult.error(key, p.name() + ": listen port " + p.listenPort() + " is in use by " + owner)));
            }
            if (System.currentTimeMillis() > deadline) {
                health.put(p.name(), Map.of("answering", false, "reason", "check timed out"));
                continue;
            }
            MachinePort.AppHealth app = machine.appHealth(p.upstreamPort());
            health.put(p.name(), app.answering()
                    ? Map.of("answering", true, "statusCode", app.statusCode(), "latencyMs", app.millis())
                    : Map.of("answering", false, "reason", app.reason()));
            if (!app.answering()) {
                out.add(ValidationResult.warning(key, p.name() + ": nothing answers on " + p.upstreamPort() + " - is the app running?"));
            }
        }
        out.add(ValidationResult.ok(key, "projects checked").with(Map.of("health", health)));
    }

    private void folder(String key, String value, List<ValidationResult> out) {
        if (value.isBlank()) {
            return;
        }
        MachinePort.FolderInfo info = machine.folder(resolve(value));
        if (!info.exists()) {
            out.add(ValidationResult.error(key, resolve(value) + " does not exist"));
        } else if (!info.readable()) {
            out.add(ValidationResult.error(key, resolve(value) + " cannot be read by Alfred's service account"));
        } else {
            out.add(ValidationResult.ok(key, info.logFiles() + " log files, readable").with(folderDetail(info)));
        }
    }

    private void folders(String key, String value, List<ValidationResult> out) {
        for (WatchedFolder f : ServicesGrammar.parseFolders(value, w -> { })) {
            MachinePort.FolderInfo info = machine.folder(resolve(f.path()));
            if (!info.exists()) {
                out.add(ValidationResult.error(key, f.name() + ": " + f.path() + " does not exist"));
            } else if (!info.readable()) {
                out.add(ValidationResult.error(key, f.name() + ": " + f.path() + " cannot be read by Alfred's service account"));
            } else {
                Map<String, Object> detail = new LinkedHashMap<>(folderDetail(info));
                detail.put("folder", f.name());
                out.add(ValidationResult.ok(key, f.name() + ": " + info.logFiles() + " log files, readable").with(detail));
            }
        }
    }

    private static Map<String, Object> folderDetail(MachinePort.FolderInfo info) {
        return Map.of("fileCount", info.logFiles(), "newestModified", info.newestModifiedMillis());
    }

    private void size(String key, String value, Map<String, String> effective, List<ValidationResult> out) {
        long cap = SettingsValidator.sizeInBytes(value);
        long used = storage.usedBytes(key);
        long free = machine.freeDiskBytes();
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("usedBytes", used);
        detail.put("freeDiskBytes", free);
        if (used > cap) {
            out.add(ValidationResult.warning(key, "below what is stored now: the oldest " + mb(used - cap) + " will be removed").with(detail));
        } else {
            out.add(ValidationResult.ok(key, used >= 0 ? mb(used) + " used" : "").with(detail));
        }
        long total = 0;
        for (String sizeKey : SIZE_KEYS) {
            total += SettingsValidator.sizeInBytes(effective.getOrDefault(sizeKey, "0"));
        }
        if (free >= 0 && total > free + usedTotal()) {
            out.add(ValidationResult.warning(key, "the limits add up to " + mb(total) + ", more than the free disk (" + mb(free) + ")"));
        }
    }

    private long usedTotal() {
        long total = 0;
        for (String key : SIZE_KEYS) {
            total += Math.max(0, storage.usedBytes(key));
        }
        return total;
    }

    private void memory(String key, String value, List<ValidationResult> out) {
        long megabytes = SettingsValidator.memoryInMegabytes(value);
        long free = machine.freeMemoryBytes();
        Map<String, Object> detail = Map.of("totalMemoryBytes", machine.totalMemoryBytes(), "freeMemoryBytes", free);
        if (free > 0 && megabytes * 1024 * 1024 > free) {
            out.add(ValidationResult.warning(key, "more than the free memory (" + mb(free) + "): the server may swap").with(detail));
        } else if (megabytes < 1024) {
            out.add(ValidationResult.warning(key, "below 1 GB: large calls may fail").with(detail));
        } else {
            out.add(ValidationResult.ok(key, "").with(detail));
        }
    }

    private void retention(String key, String value, Map<String, String> effective, List<ValidationResult> out) {
        long rows = Long.parseLong(value);
        long perHour = storage.inboundCallsLastHour();
        // Only the file store holds its retained calls in memory; the database store (the default since
        // specs/013-inbound-calls-store) keeps them on disk, whatever the count.
        boolean inMemory = "file".equalsIgnoreCase(effective.getOrDefault("INTERNAL_CALLS_STORAGE", "sqlite").strip());
        long memoryBytes = inMemory ? rows * BYTES_PER_INBOUND_CALL : 0L;
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("memoryBytes", memoryBytes);
        detail.put("callsPerHour", perHour);
        if (perHour > 0) {
            detail.put("retentionHours", (double) rows / perHour);
        }
        long heap = SettingsValidator.memoryInMegabytes(effective.getOrDefault("ALFRED_MEMORY", "2g")) * 1024 * 1024;
        if (memoryBytes > heap / 2) {
            out.add(ValidationResult.warning(key, "keeps about " + mb(memoryBytes) + " in memory - over half of ALFRED_MEMORY").with(detail));
        } else {
            out.add(ValidationResult.ok(key, "").with(detail));
        }
    }

    private String resolve(String path) {
        return path.startsWith("./") || path.startsWith(".\\") ? home.resolve(path.substring(2)).normalize().toString() : path;
    }

    private static String mb(long bytes) {
        return bytes >= 1024L * 1024 * 1024
                ? String.format("%.1f GB", bytes / (1024.0 * 1024 * 1024))
                : (bytes / (1024 * 1024)) + " MB";
    }
}
