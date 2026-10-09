package com.fathy.alfred.backend.internalcalls.adapter.out.sqlite;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Group-commit writer for one SQLite file: one background thread owns the write transactions, so concurrent webhook
 * threads never contend for SQLite's single write lock, and a burst that arrives while a commit is in flight is folded
 * into the next transaction. {@link #submit} blocks until the caller's own item is committed (or fails), so a row
 * exists before the webhook answers and before the WebSocket push.
 *
 * <p>Copied from backend-calls' {@code adapter.out.sqlite.BatchWriter} - the measured, incident-tested original
 * (slices never share code, docs/architecture.md). Every configured statement runs across the whole batch in order
 * before one commit; a failed batch is retried item by item so one bad write fails only itself.
 */
public final class BatchWriter<T> implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(BatchWriter.class);
    private static final int MAX_BATCH_SIZE = 500;
    private static final long SUBMIT_TIMEOUT_SECONDS = 30;
    private static final long ENQUEUE_TIMEOUT_SECONDS = 30;

    @FunctionalInterface
    public interface RowBinder<T> {
        void bind(PreparedStatement statement, T item) throws SQLException;
    }

    /** One SQL statement (and its binder) run, in order, for every item in a batch before the shared commit. */
    public record StatementSpec<T>(String sql, RowBinder<T> binder) {}

    private record PendingWrite<T>(T item, CompletableFuture<Void> future) {}

    private final BlockingQueue<PendingWrite<T>> queue;
    private final DataSource dataSource;
    private final List<StatementSpec<T>> statements;
    private final Thread workerThread;
    private volatile boolean running = true;

    public BatchWriter(String threadName, DataSource dataSource, List<StatementSpec<T>> statements, int queueCapacity) {
        this.queue = new LinkedBlockingQueue<>(queueCapacity);
        this.dataSource = dataSource;
        this.statements = statements;
        this.workerThread = new Thread(this::runLoop, threadName);
        this.workerThread.setDaemon(true);
        this.workerThread.start();
    }

    public void submit(T item) {
        CompletableFuture<Void> future = new CompletableFuture<>();
        boolean enqueued;
        try {
            enqueued = queue.offer(new PendingWrite<>(item, future), ENQUEUE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while enqueueing write", e);
        }
        if (!enqueued) {
            throw new IllegalStateException("Write queue is full - could not enqueue after " + ENQUEUE_TIMEOUT_SECONDS + "s");
        }
        try {
            future.get(SUBMIT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while waiting for write to commit", e);
        } catch (ExecutionException e) {
            throw new IllegalStateException("Failed to persist write", e.getCause());
        } catch (TimeoutException e) {
            throw new IllegalStateException("Timed out waiting for write to commit after " + SUBMIT_TIMEOUT_SECONDS + "s");
        }
    }

    private void runLoop() {
        Connection connection = null;
        List<PreparedStatement> preparedStatements = null;
        while (running) {
            PendingWrite<T> first;
            try {
                first = queue.poll(1, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            if (first == null) {
                continue;
            }
            List<PendingWrite<T>> batch = new ArrayList<>();
            batch.add(first);
            queue.drainTo(batch, MAX_BATCH_SIZE - 1);
            try {
                if (connection == null || connection.isClosed()) {
                    connection = dataSource.getConnection();
                    connection.setAutoCommit(false);
                    preparedStatements = prepareAll(connection);
                }
                executeWithIsolation(connection, preparedStatements, batch);
            } catch (SQLException e) {
                log.error("Writer connection failed, reopening on the next batch: {}", e.getMessage());
                closeAllQuietly(preparedStatements);
                closeQuietly(connection);
                connection = null;
                preparedStatements = null;
                batch.forEach(pw -> pw.future().completeExceptionally(e));
            }
        }
        // Graceful shutdown: persist whatever is still queued rather than drop it.
        List<PendingWrite<T>> remaining = new ArrayList<>();
        queue.drainTo(remaining);
        if (!remaining.isEmpty()) {
            try {
                if (connection == null || connection.isClosed()) {
                    connection = dataSource.getConnection();
                    connection.setAutoCommit(false);
                    preparedStatements = prepareAll(connection);
                }
                executeWithIsolation(connection, preparedStatements, remaining);
            } catch (SQLException e) {
                log.error("Could not flush {} pending write(s) during shutdown: {}", remaining.size(), e.getMessage());
                remaining.forEach(pw -> pw.future().completeExceptionally(e));
            }
        }
        closeAllQuietly(preparedStatements);
        closeQuietly(connection);
    }

    private List<PreparedStatement> prepareAll(Connection connection) throws SQLException {
        List<PreparedStatement> prepared = new ArrayList<>(statements.size());
        for (StatementSpec<T> spec : statements) {
            prepared.add(connection.prepareStatement(spec.sql()));
        }
        return prepared;
    }

    private void executeWithIsolation(Connection connection, List<PreparedStatement> preparedStatements,
                                      List<PendingWrite<T>> batch) throws SQLException {
        try {
            for (int i = 0; i < statements.size(); i++) {
                PreparedStatement ps = preparedStatements.get(i);
                RowBinder<T> binder = statements.get(i).binder();
                for (PendingWrite<T> pending : batch) {
                    ps.clearParameters();
                    binder.bind(ps, pending.item());
                    ps.addBatch();
                }
                ps.executeBatch();
            }
            connection.commit();
            batch.forEach(pw -> pw.future().complete(null));
        } catch (SQLException batchFailure) {
            rollbackQuietly(connection);
            clearBatchesQuietly(preparedStatements);
            for (PendingWrite<T> pending : batch) {
                try {
                    for (int i = 0; i < statements.size(); i++) {
                        PreparedStatement ps = preparedStatements.get(i);
                        ps.clearParameters();
                        statements.get(i).binder().bind(ps, pending.item());
                        ps.addBatch();
                        ps.executeBatch();
                    }
                    connection.commit();
                    pending.future().complete(null);
                } catch (SQLException singleFailure) {
                    rollbackQuietly(connection);
                    clearBatchesQuietly(preparedStatements);
                    pending.future().completeExceptionally(singleFailure);
                }
            }
        }
    }

    private static void clearBatchesQuietly(List<PreparedStatement> statements) {
        for (PreparedStatement ps : statements) {
            try {
                ps.clearBatch();
            } catch (SQLException ignored) {
                // Best-effort - about to retry or fail this batch either way.
            }
        }
    }

    private static void closeAllQuietly(List<PreparedStatement> statements) {
        if (statements != null) {
            statements.forEach(BatchWriter::closeQuietly);
        }
    }

    private static void rollbackQuietly(Connection connection) {
        try {
            connection.rollback();
        } catch (SQLException e) {
            log.warn("Rollback failed after a write error: {}", e.getMessage());
        }
    }

    private static void closeQuietly(AutoCloseable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (Exception ignored) {
            // Shutting down either way.
        }
    }

    @Override
    public void close() {
        running = false;
        workerThread.interrupt();
        try {
            workerThread.join(10_000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
