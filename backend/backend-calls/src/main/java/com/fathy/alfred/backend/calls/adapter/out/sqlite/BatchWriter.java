package com.fathy.alfred.backend.calls.adapter.out.sqlite;

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
 * Group-commit writer for a single SQLite file: exactly one background thread ever opens a
 * write transaction against it, so callers never contend for SQLite's single write lock with
 * each other (no SQLITE_BUSY) - and callers submitted while a commit is already in flight get
 * folded into the *next* transaction instead of paying for a commit (an fsync-equivalent WAL
 * write+sync) each on their own. Under light/sparse traffic this behaves the same as one
 * transaction per write - no artificial delay is ever added; batching only happens because a
 * burst naturally backs up in the queue while the single writer thread is busy on the previous
 * batch. {@link #submit} blocks the calling thread until its own item is actually committed
 * (or the write fails), preserving the existing "row exists before the HTTP response / before
 * the WebSocket notification" guarantee callers depend on.
 *
 * <p>The writer holds one persistent connection and one persistent {@link PreparedStatement} for
 * its whole lifetime (reopened only if a connection-level failure is detected), rather than
 * checking a connection out of the pool for every batch - avoids paying pool-checkout and
 * statement-preparation cost on every commit.
 *
 * <p>If a whole-batch {@code executeBatch()} fails (e.g. one row violates a constraint), the
 * batch is retried one row at a time so only the actually-bad row fails - a single bad write must
 * not fail every other call that happened to be batched alongside it.
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

    private record PendingWrite<T>(T item, CompletableFuture<Void> future) {}

    private final BlockingQueue<PendingWrite<T>> queue;
    private final DataSource dataSource;
    private final String insertSql;
    private final RowBinder<T> binder;
    private final Thread workerThread;
    private volatile boolean running = true;

    /**
     * @param queueCapacity Bounds how many not-yet-committed writes can be pending at once. In
     *                      practice the number of *simultaneously in-flight* callers is already
     *                      capped by the servlet container's own worker-thread pool (each blocked
     *                      caller occupies one request thread), so this exists as a second,
     *                      explicit backstop against unbounded memory growth if the writer ever
     *                      stalls - not something normal traffic is expected to hit.
     */
    public BatchWriter(String threadName, DataSource dataSource, String insertSql, RowBinder<T> binder, int queueCapacity) {
        this.queue = new LinkedBlockingQueue<>(queueCapacity);
        this.dataSource = dataSource;
        this.insertSql = insertSql;
        this.binder = binder;
        this.workerThread = new Thread(this::runLoop, threadName);
        this.workerThread.setDaemon(true);
        this.workerThread.start();
    }

    /** Enqueues {@code item} and blocks until it's committed (or the write fails, the queue is full, or either wait times out). */
    public void submit(T item) {
        CompletableFuture<Void> future = new CompletableFuture<>();
        PendingWrite<T> pending = new PendingWrite<>(item, future);
        boolean enqueued;
        try {
            enqueued = queue.offer(pending, ENQUEUE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
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
        PreparedStatement statement = null;
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
                    statement = connection.prepareStatement(insertSql);
                }
                executeWithIsolation(connection, statement, batch);
            } catch (SQLException e) {
                log.error("Writer connection failed, reopening on the next batch: {}", e.getMessage());
                closeQuietly(statement);
                closeQuietly(connection);
                connection = null;
                statement = null;
                batch.forEach(pw -> pw.future().completeExceptionally(e));
            }
        }

        // Graceful shutdown: attempt to persist whatever was still queued rather than silently
        // dropping it, using whatever connection/statement is already open (or opening one if the
        // loop above never needed to).
        List<PendingWrite<T>> remaining = new ArrayList<>();
        queue.drainTo(remaining);
        if (!remaining.isEmpty()) {
            try {
                if (connection == null || connection.isClosed()) {
                    connection = dataSource.getConnection();
                    connection.setAutoCommit(false);
                    statement = connection.prepareStatement(insertSql);
                }
                executeWithIsolation(connection, statement, remaining);
            } catch (SQLException e) {
                log.error("Could not flush {} pending write(s) during shutdown: {}", remaining.size(), e.getMessage());
                remaining.forEach(pw -> pw.future().completeExceptionally(e));
            }
        }
        closeQuietly(statement);
        closeQuietly(connection);
    }

    /** Tries the whole batch as one transaction first (the fast, common path); on any failure, rolls back and retries one row at a time so a single bad row doesn't fail every other write batched alongside it. */
    private void executeWithIsolation(Connection connection, PreparedStatement statement, List<PendingWrite<T>> batch) throws SQLException {
        try {
            for (PendingWrite<T> pending : batch) {
                statement.clearParameters();
                binder.bind(statement, pending.item());
                statement.addBatch();
            }
            statement.executeBatch();
            connection.commit();
            batch.forEach(pw -> pw.future().complete(null));
        } catch (SQLException batchFailure) {
            rollbackQuietly(connection);
            statement.clearBatch();
            for (PendingWrite<T> pending : batch) {
                try {
                    statement.clearParameters();
                    binder.bind(statement, pending.item());
                    statement.addBatch();
                    statement.executeBatch();
                    connection.commit();
                    pending.future().complete(null);
                } catch (SQLException singleFailure) {
                    rollbackQuietly(connection);
                    statement.clearBatch();
                    pending.future().completeExceptionally(singleFailure);
                }
            }
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

    /** Signals the worker to stop, then waits (bounded) for it to drain any still-queued writes and close its connection - so a graceful shutdown doesn't silently lose in-flight writes. */
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
