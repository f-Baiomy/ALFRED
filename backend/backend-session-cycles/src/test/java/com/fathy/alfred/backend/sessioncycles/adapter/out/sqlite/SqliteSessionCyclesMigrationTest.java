package com.fathy.alfred.backend.sessioncycles.adapter.out.sqlite;

import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteSessionCyclesMigrationTest {

    @TempDir
    Path tempDir;

    private final List<SqliteSessionCyclesRepository> opened = new ArrayList<>();

    @AfterEach
    void closeRepositories() throws InterruptedException {
        opened.forEach(SqliteSessionCyclesRepository::close);
        Thread.sleep(50);
    }

    private SqliteSessionCyclesRepository repositoryFor(Path dbFile) throws Exception {
        SqliteSessionCyclesRepository repository = new SqliteSessionCyclesRepository();
        setField(repository, SqliteSessionCyclesRepository.class, "dbFile", dbFile.toString());
        repository.init();
        opened.add(repository);
        return repository;
    }

    private SqliteSessionCyclesMigration migrationFor(SqliteSessionCyclesRepository repository, Path metadataFile, Path capturedCallsDir) throws Exception {
        SqliteSessionCyclesMigration migration = new SqliteSessionCyclesMigration(repository);
        setField(migration, SqliteSessionCyclesMigration.class, "legacyMetadataFile", metadataFile.toString());
        setField(migration, SqliteSessionCyclesMigration.class, "legacyCapturedCallsDir", capturedCallsDir.toString());
        return migration;
    }

    private static void setField(Object target, Class<?> type, String name, Object value) throws Exception {
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    @Test
    void migratesCyclesAndTheirCapturedCallsAndRenamesBothLegacyFiles() throws Exception {
        Path dir = Files.createDirectories(tempDir.resolve("session-cycles"));
        Path metadataFile = dir.resolve("session-cycles.json");
        Files.writeString(metadataFile, """
                [{"id":"c1","name":"Repro","createdAt":"2026-01-01T00:00:00Z","assignedTo":null,"status":"PAUSED"}]
                """);
        Path capturedFile = dir.resolve("c1.json");
        Files.writeString(capturedFile, """
                [{"id":"captured-1","capturedAt":"2026-01-01T00:00:00Z","call":{"id":"call-1","original_url":"https://a.com-proxy/x","url":"https://a.com/x","method":"GET","timestamp":"t1"}}]
                """);

        SqliteSessionCyclesRepository repository = repositoryFor(tempDir.resolve("session-cycles.db"));
        SqliteSessionCyclesMigration migration = migrationFor(repository, metadataFile, dir);

        migration.migrateIfPresent();

        List<SessionCycle> cycles = repository.findAllCycles();
        assertThat(cycles).extracting(SessionCycle::id).containsExactly("c1");

        List<CapturedCall> captured = repository.findAllByCycle("c1");
        assertThat(captured).extracting(c -> c.call().url()).containsExactly("https://a.com/x");

        assertThat(metadataFile).doesNotExist();
        assertThat(dir.resolve("session-cycles.json.migrated")).exists();
        assertThat(capturedFile).doesNotExist();
        assertThat(dir.resolve("c1.json.migrated")).exists();
    }

    @Test
    void migratesOrphanedCapturedCallsFilesNotListedInMetadata() throws Exception {
        Path dir = Files.createDirectories(tempDir.resolve("session-cycles"));
        Path metadataFile = dir.resolve("session-cycles.json");
        Files.writeString(metadataFile, "[]");
        Path orphanFile = dir.resolve("orphan-cycle.json");
        Files.writeString(orphanFile, """
                [{"id":"captured-1","capturedAt":"2026-01-01T00:00:00Z","call":{"id":"call-1","original_url":"https://a.com-proxy/x","url":"https://a.com/x","method":"GET","timestamp":"t1"}}]
                """);

        SqliteSessionCyclesRepository repository = repositoryFor(tempDir.resolve("session-cycles.db"));
        SqliteSessionCyclesMigration migration = migrationFor(repository, metadataFile, dir);

        migration.migrateIfPresent();

        assertThat(repository.findAllByCycle("orphan-cycle")).extracting(c -> c.call().url()).containsExactly("https://a.com/x");
        assertThat(orphanFile).doesNotExist();
    }

    @Test
    void doesNothingWhenTheLegacyMetadataFileDoesNotExist() throws Exception {
        Path dir = tempDir.resolve("session-cycles");
        SqliteSessionCyclesRepository repository = repositoryFor(tempDir.resolve("session-cycles.db"));
        SqliteSessionCyclesMigration migration = migrationFor(repository, dir.resolve("session-cycles.json"), dir);

        migration.migrateIfPresent();

        assertThat(repository.findAllCycles()).isEmpty();
    }

    @Test
    void doesNotReMigrateOnceCyclesAlreadyExist() throws Exception {
        Path dir = Files.createDirectories(tempDir.resolve("session-cycles"));
        Path metadataFile = dir.resolve("session-cycles.json");
        Files.writeString(metadataFile, """
                [{"id":"c1","name":"Repro","createdAt":"2026-01-01T00:00:00Z","assignedTo":null,"status":"PAUSED"}]
                """);
        SqliteSessionCyclesRepository repository = repositoryFor(tempDir.resolve("session-cycles.db"));
        repository.saveCycle(new SessionCycle("existing", "Already here", "t", null, com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus.PAUSED));
        SqliteSessionCyclesMigration migration = migrationFor(repository, metadataFile, dir);

        migration.migrateIfPresent();

        assertThat(metadataFile).exists();
        assertThat(repository.findAllCycles()).extracting(SessionCycle::id).containsExactly("existing");
    }
}
