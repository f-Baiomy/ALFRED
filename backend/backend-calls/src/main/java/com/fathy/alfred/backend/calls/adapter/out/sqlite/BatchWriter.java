package com.fathy.alfred.backend.calls.adapter.out.sqlite;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.sql.DataSource;
import java.sql.Connection;
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
 */
public final class BatchWriter<T> implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(BatchWriter.class);
    private static final int MAX_BATCH_SIZE = 500;
    private static final long SUBMIT_TIMEOUT_SECONDS = 30;

    @FunctionalInterface
    public interface BatchInsert<T> {
        void insert(Connection connection, List<T> batch) throws SQLException;
    }

    private record PendingWrite<T>(T item, CompletableFuture<Void> future) {}

    private final BlockingQueue<PendingWrite<T>> queue = new LinkedBlockingQueue<>();
    private final Thread workerThread;
    private volatile boolean running = true;

    public BatchWriter(String threadName, DataSource dataSource, BatchInsert<T> batchInsert) {
        this.workerThread = new Thread(() -> runLoop(dataSource, batchInsert), threadName);
        this.workerThread.setDaemon(true);
        this.workerThread.start();
    }

    /** Enqueues {@code item} and blocks until it's committed (or the write fails, or the wait times out). */
    public void submit(T item) {
        CompletableFuture<Void> future = new CompletableFuture<>();
        queue.add(new PendingWrite<>(item, future));
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

    private void runLoop(DataSource dataSource, BatchInsert<T> batchInsert) {
        while (running) {
            PendingWrite<T> first;
            try {
                first = queue.poll(1, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            if (first == null) {
                continue;
            }
            List<PendingWrite<T>> batch = new ArrayList<>();
            batch.add(first);
            queue.drainTo(batch, MAX_BATCH_SIZE - 1);

            try (Connection connection = dataSource.getConnection()) {
                connection.setAutoCommit(false);
                try {
                    batchInsert.insert(connection, batch.stream().map(PendingWrite::item).toList());
                    connection.commit();
                    batch.forEach(pw -> pw.future().complete(null));
                } catch (SQLException e) {
                    try {
                        connection.rollback();
                    } catch (SQLException rollbackFailure) {
                        log.warn("Rollback also failed after a batch write error: {}", rollbackFailure.getMessage());
                    }
                    batch.forEach(pw -> pw.future().completeExceptionally(e));
                }
            } catch (SQLException e) {
                batch.forEach(pw -> pw.future().completeExceptionally(e));
            }
        }
    }

    @Override
    public void close() {
        running = false;
        workerThread.interrupt();
    }
}
