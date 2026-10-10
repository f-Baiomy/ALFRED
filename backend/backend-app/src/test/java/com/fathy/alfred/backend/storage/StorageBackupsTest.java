package com.fathy.alfred.backend.storage;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** A backup is a consistent copy; a restore waits for the next start and keeps what it replaced. */
class StorageBackupsTest {

    @TempDir
    Path dir;

    private StorageFiles files;
    private StorageBackups backups;

    @BeforeEach
    void setUp() throws Exception {
        String d = dir.toString() + "/";
        files = new StorageFiles(d + "calls.db", d + "internal-calls.db", d + "db-capture.db", d + "logs.db", d + "triage.db",
                d + "session-cycles.db", d + "comments.db", d + "relive.db", d + "scenarios.db", d + "settings.db", d + "profiles.db",
                d + "redactions.db", d + "interception.db");
        backups = new StorageBackups(files, Optional.of(Clock.fixed(Instant.parse("2026-10-10T12:00:00Z"), ZoneOffset.UTC)));
        db("comments.db", "first");
        db("settings.db", "setting");
    }

    private void db(String name, String value) throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dir.resolve(name)); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE IF NOT EXISTS t (v TEXT)");
            s.execute("DELETE FROM t");
            s.execute("INSERT INTO t VALUES ('" + value + "')");
        }
    }

    private String value(String name) {
        return SqliteFiles.text(dir.resolve(name), "SELECT v FROM t");
    }

    @Test
    void backsUpTheChosenGroupsIntoTheBackupsFolder() {
        StorageBackups.Backup b = backups.backUp(List.of("work", "config"), false);

        assertThat(b.name()).isEqualTo("alfred-backup-20261010-120000.zip");
        assertThat(b.files()).containsExactlyInAnyOrder("comments.db", "settings.db");
        assertThat(backups.list().backups()).extracting(StorageBackups.Backup::name).containsExactly(b.name());
        assertThat(files.history().get(0).what()).contains("Backed up");
    }

    @Test
    void aRestoreReplacesTheFilesAtTheNextStartAndKeepsTheOldOnes() throws Exception {
        StorageBackups.Backup b = backups.backUp(List.of("work"), false);
        db("comments.db", "changed later");

        StorageBackups.Pending pending = backups.stageRestore(b.name());
        assertThat(pending.files()).containsExactly("comments.db");
        assertThat(value("comments.db")).isEqualTo("changed later");

        List<String> restored = StagedRestore.apply(dir);

        assertThat(restored).containsExactly("comments.db");
        assertThat(value("comments.db")).isEqualTo("first");
        assertThat(Files.exists(dir.resolve("restore-pending"))).isFalse();
        try (var replaced = Files.walk(dir.resolve("restore-replaced"))) {
            assertThat(replaced.anyMatch(p -> p.getFileName().toString().equals("comments.db"))).isTrue();
        }
        assertThat(StagedRestore.apply(dir)).isEmpty();
    }

    @Test
    void aCancelledRestoreChangesNothing() throws Exception {
        StorageBackups.Backup b = backups.backUp(List.of("work"), false);
        backups.stageRestore(b.name());
        backups.cancelRestore();

        assertThat(backups.list().pending()).isNull();
        assertThat(StagedRestore.apply(dir)).isEmpty();
    }

    @Test
    void backUpNowAnswersWithTheBackupWhenItFinishesInTime() {
        assertThat(backups.backUpWithin(List.of("config"), 30)).hasValueSatisfying(b -> assertThat(b.files()).containsExactly("settings.db"));
    }

    @Test
    void anUploadedBackupArrivesInChunksAndCanBeRestored() throws Exception {
        StorageBackups.Backup made = backups.backUp(List.of("work"), false);
        byte[] zip = Files.readAllBytes(dir.resolve("backups").resolve(made.name()));
        Files.delete(dir.resolve("backups").resolve(made.name()));
        int half = zip.length / 2;

        assertThat(backups.receiveChunk("abcd1234", 0, zip.length, new java.io.ByteArrayInputStream(zip, 0, half))).isEmpty();
        StorageBackups.Backup uploaded = backups.receiveChunk("abcd1234", half, zip.length,
                new java.io.ByteArrayInputStream(zip, half, zip.length - half)).orElseThrow();

        assertThat(uploaded.files()).contains("comments.db");
        assertThat(backups.stageRestore(uploaded.name()).files()).containsExactly("comments.db");
    }

    @Test
    void anUploadThatIsNotABackupOrComesOutOfOrderIsRefused() {
        byte[] junk = "not a zip".getBytes();
        assertThatThrownBy(() -> backups.receiveChunk("abcd1234", 0, junk.length, new java.io.ByteArrayInputStream(junk)))
                .hasMessageContaining("not an Alfred backup");
        assertThatThrownBy(() -> backups.receiveChunk("abcd5678", 10, 20, new java.io.ByteArrayInputStream(junk)))
                .hasMessageContaining("out of order");
        assertThatThrownBy(() -> backups.receiveChunk("../x", 0, 1, new java.io.ByteArrayInputStream(junk)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void onlyItsOwnBackupNamesAreServed() {
        assertThatThrownBy(() -> backups.file("../calls.db")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> backups.backUp(List.of("everything"), false)).hasMessageContaining("Unknown group");
    }
}
