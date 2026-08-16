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
 * <p>The writer holds one persistent connection and one persistent {@link PreparedStatement} per
 * configured statement for its whole lifetime (reopened only if a connection-level failure is
 * detected), rather than checking a connection out of the pool for every batch - avoids paying
 * pool-checkout and statement-preparation cost on every commit.
 *
 * <p>One item can require more than one statement against the same connection/transaction - e.g.
 * a prepared call now writes both a {@code call_metadata} row and a {@code call_request} row.
 * Each configured {@link StatementSpec} runs across the whole batch in order (all items' first
 * statement, then all items' second statement, ...) before a single commit - never one commit per
 * statement - so a partial write (metadata without its request row) can never survive a crash
 * mid-batch.
 *
 * <p>If a whole-batch {@code executeBatch()} fails (e.g. one row violates a constraint), the
 * batch is retried one item at a time (running every statement for that item, then committing)
 * so only the actually-bad item fails - a single bad write must not fail every other call that
 * happened to be batched alongside it.
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

    /**
     * @param queueCapacity Bounds how many not-yet-committed writes can be pending at once. In
     *                      practice the number of *simultaneously in-flight* callers is already
     *                      capped by the servlet container's own worker-thread pool (each blocked
     *                      caller occupies one request thread), so this exists as a second,
     *                      explicit backstop against unbounded memory growth if the writer ever
     *                      stalls - not something normal traffic is expected to hit.
     */
    public BatchWriter(String threadName, DataSource dataSource, String insertSql, RowBinder<T> binder, int queueCapacity) {
        this(threadName, dataSource, List.of(new StatementSpec<>(insertSql, binder)), queueCapacity);
    }

    /** As above, but running every statement in {@code statements} (in order) against the same connection/transaction per item, one shared commit per batch. */
    public BatchWriter(String threadName, DataSource dataSource, List<StatementSpec<T>> statements, int queueCapacity) {
        this.queue = new LinkedBlockingQueue<>(queueCapacity);
        this.dataSource = dataSource;
        this.statements = statements;
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

        // Graceful shutdown: attempt to persist whatever was still queued rather than silently
        // dropping it, using whatever connection/statements are already open (or opening them if
        // the loop above never needed to).
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

    /**
     * Tries the whole batch as one transaction first (the fast, common path): every configured
     * statement runs across all items in {@code batch} (all items' first statement, then all
     * items' second statement, ...), then a single commit. On any failure, rolls back and retries
     * one item at a time - running every statement for that item, then committing - so a single
     * bad item doesn't fail every other write batched alongside it, and a multi-statement item
     * never partially commits (e.g. metadata without its request row).
     */
    private void executeWithIsolation(Connection connection, List<PreparedStatement> preparedStatements, List<PendingWrite<T>> batch) throws SQLException {
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
                        RowBinder<T> binder = statements.get(i).binder();
                        ps.clearParameters();
                        binder.bind(ps, pending.item());
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
        if (statements == null) {
            return;
        }
        statements.forEach(BatchWriter::closeQuietly);
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
