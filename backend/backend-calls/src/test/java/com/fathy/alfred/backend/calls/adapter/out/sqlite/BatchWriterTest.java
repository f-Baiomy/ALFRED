package com.fathy.alfred.backend.calls.adapter.out.sqlite;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class BatchWriterTest {

    @TempDir
    Path tempDir;

    private final List<HikariDataSource> opened = new ArrayList<>();
    private final List<BatchWriter<?>> writers = new ArrayList<>();

    @AfterEach
    void tearDown() throws InterruptedException {
        writers.forEach(BatchWriter::close);
        opened.forEach(HikariDataSource::close);
        Thread.sleep(50);
    }

    private HikariDataSource dataSourceFor(Path dbFile) {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl("jdbc:sqlite:" + dbFile);
        config.setMaximumPoolSize(4);
        config.setConnectionInitSql("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000;");
        HikariDataSource dataSource = new HikariDataSource(config);
        opened.add(dataSource);
        try (var connection = dataSource.getConnection(); var statement = connection.createStatement()) {
            statement.execute("CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT)");
        } catch (SQLException e) {
            throw new RuntimeException(e);
        }
        return dataSource;
    }

    private BatchWriter<String[]> writerFor(HikariDataSource dataSource) {
        BatchWriter<String[]> writer = new BatchWriter<>("test-writer", dataSource,
                "INSERT INTO items (id, value) VALUES (?,?)",
                (ps, row) -> {
                    ps.setString(1, row[0]);
                    ps.setString(2, row[1]);
                },
                1000);
        writers.add(writer);
        return writer;
    }

    private List<String> allIds(HikariDataSource dataSource) throws SQLException {
        List<String> ids = new ArrayList<>();
        try (var connection = dataSource.getConnection();
             var statement = connection.createStatement();
             var rs = statement.executeQuery("SELECT id FROM items ORDER BY rowid ASC")) {
            while (rs.next()) {
                ids.add(rs.getString("id"));
            }
        }
        return ids;
    }

    @Test
    void submitBlocksUntilCommittedAndTheRowIsThenVisible() throws Exception {
        HikariDataSource dataSource = dataSourceFor(tempDir.resolve("a.db"));
        BatchWriter<String[]> writer = writerFor(dataSource);

        writer.submit(new String[]{"id-1", "value-1"});

        assertThat(allIds(dataSource)).containsExactly("id-1");
    }

    @Test
    void concurrentSubmitsAllSucceedAndAreAllPersisted() throws Exception {
        HikariDataSource dataSource = dataSourceFor(tempDir.resolve("b.db"));
        BatchWriter<String[]> writer = writerFor(dataSource);

        int count = 20;
        List<Thread> threads = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            String id = "id-" + i;
            Thread t = new Thread(() -> writer.submit(new String[]{id, "v"}));
            threads.add(t);
            t.start();
        }
        for (Thread t : threads) {
            t.join(10_000);
        }

        assertThat(allIds(dataSource)).hasSize(count);
    }

    @Test
    void aDuplicateIdFailureDoesNotFailAConcurrentValidWrite() throws Exception {
        HikariDataSource dataSource = dataSourceFor(tempDir.resolve("c.db"));
        BatchWriter<String[]> writer = writerFor(dataSource);
        writer.submit(new String[]{"existing", "original"});

        CountDownLatch bothReady = new CountDownLatch(2);
        AtomicReference<Throwable> duplicateFailure = new AtomicReference<>();
        AtomicReference<Throwable> validFailure = new AtomicReference<>();

        Thread duplicateSubmitter = new Thread(() -> {
            bothReady.countDown();
            try {
                bothReady.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
            }
            try {
                writer.submit(new String[]{"existing", "duplicate"});
            } catch (Throwable t) {
                duplicateFailure.set(t);
            }
        });
        Thread validSubmitter = new Thread(() -> {
            bothReady.countDown();
            try {
                bothReady.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
            }
            try {
                writer.submit(new String[]{"fresh", "value"});
            } catch (Throwable t) {
                validFailure.set(t);
            }
        });
        duplicateSubmitter.start();
        validSubmitter.start();
        duplicateSubmitter.join(10_000);
        validSubmitter.join(10_000);

        // The row that violates the PRIMARY KEY constraint fails...
        assertThat(duplicateFailure.get()).isNotNull();
        // ...but the unrelated, valid write submitted at the same time must still succeed, even if
        // both happened to land in the same batch - a single bad row must not poison its batch-mates.
        assertThat(validFailure.get()).isNull();
        assertThat(allIds(dataSource)).contains("existing", "fresh");
    }

    @Test
    void closeDrainsAnyWriteStillQueuedRatherThanLosingIt() throws Exception {
        HikariDataSource dataSource = dataSourceFor(tempDir.resolve("d.db"));
        BatchWriter<String[]> writer = writerFor(dataSource);

        // Fire-and-forget from a background thread (not waiting on submit()'s own blocking
        // future) so this test thread can call close() as fast as possible afterward, exercising
        // the "still queued when shutdown starts" case rather than the trivial already-committed one.
        Thread submitter = new Thread(() -> writer.submit(new String[]{"in-flight", "value"}));
        submitter.start();
        submitter.join(10_000);

        writer.close();

        assertThat(allIds(dataSource)).containsExactly("in-flight");
    }

    @Test
    void submitThrowsWhenTheWriteFailsWithNoRetryLoop() throws Exception {
        HikariDataSource dataSource = dataSourceFor(tempDir.resolve("e.db"));
        BatchWriter<String[]> writer = writerFor(dataSource);
        writer.submit(new String[]{"dup", "first"});

        assertThatThrownBy(() -> writer.submit(new String[]{"dup", "second"}))
                .isInstanceOf(IllegalStateException.class);
    }
}
