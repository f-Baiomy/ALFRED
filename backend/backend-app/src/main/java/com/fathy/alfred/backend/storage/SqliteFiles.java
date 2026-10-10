package com.fathy.alfred.backend.storage;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.OptionalLong;

/**
 * Reads what a SQLite file holds on disk - its size, its write log ({@code -wal}) and the free pages inside it - and
 * gives empty space back. Opens its own short connection: every slice's store keeps its pool, and SQLite allows a
 * second connection to read the header pragmas, checkpoint the write log and vacuum (it waits up to 30 s for a writer
 * to finish, then gives up rather than block the slice).
 */
final class SqliteFiles {

    private static final Logger log = LoggerFactory.getLogger(SqliteFiles.class);

    private SqliteFiles() {
    }

    /** Size on disk, write log, and bytes inside the file that hold nothing (free pages). */
    record FileStats(long fileBytes, long walBytes, long freeBytes) {
        long totalBytes() {
            return fileBytes + walBytes;
        }

        static final FileStats MISSING = new FileStats(0, 0, 0);
    }

    static FileStats stats(Path file) {
        if (file == null || !Files.isRegularFile(file)) {
            return FileStats.MISSING;
        }
        long size = sizeOf(file);
        long wal = sizeOf(file.resolveSibling(file.getFileName() + "-wal"));
        long free = 0;
        try (Connection c = open(file); Statement s = c.createStatement()) {
            long pageSize = single(s, "PRAGMA page_size");
            long freePages = single(s, "PRAGMA freelist_count");
            free = Math.max(0, Math.min(size, pageSize * freePages));
        } catch (SQLException e) {
            log.debug("Could not read the free pages of {}: {}", file, e.getMessage());
        }
        return new FileStats(size, wal, free);
    }

    /** A single number from a read-only query, empty when the table or file is not there. */
    static OptionalLong number(Path file, String sql) {
        if (file == null || !Files.isRegularFile(file)) {
            return OptionalLong.empty();
        }
        try (Connection c = open(file); Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) {
            return rs.next() ? OptionalLong.of(rs.getLong(1)) : OptionalLong.empty();
        } catch (SQLException e) {
            return OptionalLong.empty();
        }
    }

    /**
     * Bytes each table holds, its indexes included (the dbstat table), empty when this SQLite build has no dbstat.
     * Lets one file be split between two kinds of data - relive.db holds cycles AND their run history.
     */
    static java.util.Map<String, Long> tableBytes(Path file) {
        java.util.Map<String, Long> out = new java.util.LinkedHashMap<>();
        if (file == null || !Files.isRegularFile(file)) {
            return out;
        }
        try (Connection c = open(file); Statement s = c.createStatement();
             ResultSet rs = s.executeQuery("SELECT COALESCE(m.tbl_name, d.name), SUM(d.pgsize) FROM dbstat d "
                     + "LEFT JOIN sqlite_master m ON m.name = d.name GROUP BY 1")) {
            while (rs.next()) {
                out.put(rs.getString(1), rs.getLong(2));
            }
        } catch (SQLException e) {
            log.debug("No dbstat for {}: {}", file, e.getMessage());
        }
        return out;
    }

    /** A single text value from a read-only query, null when absent. */
    static String text(Path file, String sql) {
        if (file == null || !Files.isRegularFile(file)) {
            return null;
        }
        try (Connection c = open(file); Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) {
            return rs.next() ? rs.getString(1) : null;
        } catch (SQLException e) {
            return null;
        }
    }

    /**
     * Gives the file's empty space and its write log back to the disk; deletes nothing. Always VACUUM, also for an
     * incremental-vacuum file: {@code PRAGMA incremental_vacuum} frees one page per step and a JDBC execute steps it
     * once (see SqliteCallsRepository.usedBytes). VACUUM's cost grows with the data the file keeps, not with the empty
     * space. Returns the bytes freed.
     */
    static long compact(Path file) {
        FileStats before = stats(file);
        if (before == FileStats.MISSING) {
            return 0;
        }
        try (Connection c = open(file); Statement s = c.createStatement()) {
            s.execute("PRAGMA busy_timeout = 30000");
            s.execute("PRAGMA wal_checkpoint(TRUNCATE)");
            if (before.freeBytes() > 0) {
                s.execute("VACUUM");
                s.execute("PRAGMA wal_checkpoint(TRUNCATE)");
            }
        } catch (SQLException e) {
            throw new IllegalStateException("Could not free the space in " + file.getFileName() + ": " + e.getMessage(), e);
        }
        FileStats after = stats(file);
        return Math.max(0, before.totalBytes() - after.totalBytes());
    }

    /** Folds the write log into the file ({@code wal_checkpoint(TRUNCATE)}); returns the write-log bytes given back. */
    static long checkpoint(Path file) {
        FileStats before = stats(file);
        if (before == FileStats.MISSING || before.walBytes() == 0) {
            return 0;
        }
        try (Connection c = open(file); Statement s = c.createStatement()) {
            s.execute("PRAGMA busy_timeout = 30000");
            s.execute("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (SQLException e) {
            throw new IllegalStateException("Could not fold the write log of " + file.getFileName() + ": " + e.getMessage(), e);
        }
        return Math.max(0, before.walBytes() - stats(file).walBytes());
    }

    /** SQLite's own consistency check ({@code quick_check}): "ok", or the first problem it found. */
    static String quickCheck(Path file) {
        if (file == null || !Files.isRegularFile(file)) {
            return "missing";
        }
        try (Connection c = open(file); Statement s = c.createStatement(); ResultSet rs = s.executeQuery("PRAGMA quick_check(1)")) {
            return rs.next() ? rs.getString(1) : "ok";
        } catch (SQLException e) {
            return e.getMessage();
        }
    }

    /** A consistent, compacted copy of the file at {@code target} ({@code VACUUM INTO}) - safe while Alfred writes. */
    static void copyTo(Path file, Path target) {
        try (Connection c = open(file); Statement s = c.createStatement()) {
            s.execute("PRAGMA busy_timeout = 30000");
            Files.deleteIfExists(target);
            s.execute("VACUUM INTO '" + target.toAbsolutePath().toString().replace("'", "''") + "'");
        } catch (SQLException | IOException e) {
            throw new IllegalStateException("Could not copy " + file.getFileName() + ": " + e.getMessage(), e);
        }
    }

    private static Connection open(Path file) throws SQLException {
        Connection c = DriverManager.getConnection("jdbc:sqlite:" + file.toAbsolutePath());
        try (Statement s = c.createStatement()) {
            s.execute("PRAGMA busy_timeout = 5000");
        }
        return c;
    }

    private static long single(Statement s, String sql) throws SQLException {
        try (ResultSet rs = s.executeQuery(sql)) {
            return rs.next() ? rs.getLong(1) : 0;
        }
    }

    private static long sizeOf(Path file) {
        try {
            return Files.isRegularFile(file) ? Files.size(file) : 0;
        } catch (IOException e) {
            return 0;
        }
    }
}
