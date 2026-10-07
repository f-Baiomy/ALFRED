package com.fathy.alfred.backend.server.application.service;

import com.fathy.alfred.backend.server.application.port.out.MachinePort;
import com.fathy.alfred.backend.server.application.port.out.StorageStatsPort;
import com.fathy.alfred.backend.server.domain.model.ValidationResult;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class MachineProbesTest {

    private static final long GB = 1024L * 1024 * 1024;

    private final Map<Integer, String> busy = new HashMap<>(Map.of(8080, "java (pid 3120)", 3000, "java (pid 99)"));
    private final Map<String, MachinePort.FolderInfo> folders = new HashMap<>();
    private final Map<Integer, MachinePort.AppHealth> apps = new HashMap<>();

    private final MachinePort machine = new MachinePort() {
        public Optional<String> portOwner(int port) { return Optional.ofNullable(busy.get(port)); }
        public FolderInfo folder(String path) { return folders.getOrDefault(path, new FolderInfo(false, false, 0, 0)); }
        public long freeDiskBytes() { return 20 * GB; }
        public long totalMemoryBytes() { return 16 * GB; }
        public long freeMemoryBytes() { return 4 * GB; }
        public AppHealth appHealth(int port) { return apps.getOrDefault(port, new AppHealth(-1, 0, "nothing listening on " + port)); }
    };

    private final StorageStatsPort storage = new StorageStatsPort() {
        public long usedBytes(String key) { return key.equals("ALFRED_CALLS_MAX_SIZE_BYTES") ? 3 * GB : 0; }
        public long inboundCallsLastHour() { return 1000; }
    };

    private final Map<String, String> running = new HashMap<>(Map.of("ALFRED_UI_PORT", "3000",
            "INTERNAL_CALL_SERVICES", "a:9001:8080", "ALFRED_OUTBOUND_PROXY_LISTEN", "127.0.0.2:443"));

    private List<ValidationResult> check(Map<String, String> effective, String... keys) {
        return new MachineProbes(machine, storage, () -> running, Path.of("/opt/alfred")).check(effective, Set.of(keys));
    }

    private static List<ValidationResult> level(List<ValidationResult> results, ValidationResult.Level level) {
        return results.stream().filter(r -> r.level() == level).toList();
    }

    @Test
    void aBusyPortIsAnErrorNamingTheProcess_butAlfredsOwnPortIsFine() {
        assertThat(level(check(Map.of("ALFRED_UI_PORT", "8080"), "ALFRED_UI_PORT"), ValidationResult.Level.ERROR))
                .singleElement().satisfies(r -> assertThat(r.message()).isEqualTo("port 8080 is in use by java (pid 3120)"));
        assertThat(check(Map.of("ALFRED_UI_PORT", "3000"), "ALFRED_UI_PORT"))
                .singleElement().satisfies(r -> assertThat(r.message()).contains("Alfred itself"));
        assertThat(check(Map.of("ALFRED_UI_PORT", "3100"), "ALFRED_UI_PORT"))
                .singleElement().satisfies(r -> assertThat(r.level()).isEqualTo(ValidationResult.Level.OK));
    }

    @Test
    void aNewProjectOnABusyPortIsAnError_andAnAppNotAnsweringOnlyAWarning() {
        busy.put(9002, "nginx (pid 7)");
        apps.put(8080, new MachinePort.AppHealth(200, 12, ""));
        List<ValidationResult> results = check(Map.of("INTERNAL_CALL_SERVICES", "a:9001:8080,b:9002:8081"), "INTERNAL_CALL_SERVICES");
        assertThat(level(results, ValidationResult.Level.ERROR)).singleElement()
                .satisfies(r -> assertThat(r.message()).contains("b: listen port 9002 is in use by nginx"));
        assertThat(level(results, ValidationResult.Level.WARNING)).singleElement()
                .satisfies(r -> assertThat(r.message()).contains("nothing answers on 8081"));
        assertThat(level(results, ValidationResult.Level.OK).get(0).detail()).containsKey("health");
    }

    @Test
    void missingFoldersAreErrorsAndRelativePathsAreInsideTheInstall() {
        folders.put("/var/log/app", new MachinePort.FolderInfo(true, true, 4, 1L));
        folders.put(Path.of("/opt/alfred").resolve("logs-drop").normalize().toString(), new MachinePort.FolderInfo(true, true, 0, 0));
        List<ValidationResult> results = check(Map.of("ALFRED_LOGS_WATCH_DIRS", "app:/var/log/app,gone:/nope",
                "ALFRED_LOGS_DIR", "./logs-drop"), "ALFRED_LOGS_WATCH_DIRS", "ALFRED_LOGS_DIR");
        assertThat(level(results, ValidationResult.Level.ERROR)).singleElement()
                .satisfies(r -> assertThat(r.message()).isEqualTo("gone: /nope does not exist"));
        assertThat(level(results, ValidationResult.Level.OK)).hasSize(2);
    }

    @Test
    void aCapBelowWhatIsStoredWarnsHowMuchWillGo() {
        List<ValidationResult> results = check(Map.of("ALFRED_CALLS_MAX_SIZE_BYTES", String.valueOf(2 * GB),
                "ALFRED_DB_CAPTURE_MAX_SIZE_BYTES", "0", "ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES", "0"), "ALFRED_CALLS_MAX_SIZE_BYTES");
        assertThat(level(results, ValidationResult.Level.WARNING)).singleElement()
                .satisfies(r -> assertThat(r.message()).contains("the oldest 1.0 GB will be removed"));
    }

    @Test
    void memoryAboveTheFreeRamAndTheRetentionEstimate() {
        assertThat(level(check(Map.of("ALFRED_MEMORY", "8g"), "ALFRED_MEMORY"), ValidationResult.Level.WARNING)).hasSize(1);
        ValidationResult retention = check(Map.of("INTERNAL_CALLS_RETENTION_ROWS", "5000", "ALFRED_MEMORY", "2g"),
                "INTERNAL_CALLS_RETENTION_ROWS").get(0);
        assertThat(retention.detail()).containsEntry("retentionHours", 5.0).containsEntry("memoryBytes", 5000L * 28 * 1024);
    }

    @Test
    void probingStopsAtTheBudgetAndSaysSo() {
        MachinePort slow = new MachinePort() {
            public Optional<String> portOwner(int port) {
                try { Thread.sleep(MachineProbes.BUDGET_MILLIS + 50); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                return Optional.empty();
            }
            public FolderInfo folder(String path) { return machine.folder(path); }
            public long freeDiskBytes() { return 0; }
            public long totalMemoryBytes() { return 0; }
            public long freeMemoryBytes() { return 0; }
            public AppHealth appHealth(int port) { return machine.appHealth(port); }
        };
        List<ValidationResult> results = new MachineProbes(slow, storage, () -> running, Path.of("/opt/alfred"))
                .check(Map.of("ALFRED_UI_PORT", "3100", "ALFRED_LOGS_DIR", "/x"), new java.util.LinkedHashSet<>(List.of("ALFRED_UI_PORT", "ALFRED_LOGS_DIR")));
        assertThat(results).anySatisfy(r -> assertThat(r.message()).isEqualTo("check timed out"));
    }
}
