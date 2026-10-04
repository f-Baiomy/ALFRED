package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import com.fathy.alfred.backend.dbcapture.application.port.out.QuerySandboxPort;
import com.fathy.alfred.backend.dbcapture.domain.model.RecordedQueryResult;
import org.sqlite.ProgressHandler;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Runs a user's SELECT over recorded data in a FRESH in-memory SQLite database per request (research D14): one table,
 * loaded from the rows the caller passes, then {@code PRAGMA query_only=ON}, then the query - with a 3 s progress
 * watchdog. There is nothing else in that database to see, nothing it can write, and it is gone when the request ends.
 * Only one SELECT/WITH statement is accepted.
 */
@Component
public class InMemoryQuerySandbox implements QuerySandboxPort {

    static final long TIMEOUT_MILLIS = 3_000;
    static final int MAX_RESULT_ROWS = 50_000;
    private static final Pattern LEADING = Pattern.compile("(?is)^\\s*(SELECT|WITH)\\b");
    private static final Pattern NO_COLUMN = Pattern.compile("no such column: ([^\\s)]+)");

    @Override
    public RecordedQueryResult run(String table, List<String> columns, List<List<Object>> rows, String sql, List<Object> params,
                                   int offset, int limit) {
        String query = stripTrailingSemicolon(sql);
        if (!LEADING.matcher(query).find()) {
            return RecordedQueryResult.failed("Only a SELECT (or WITH ... SELECT) over " + table + " can run here.");
        }
        if (hasSecondStatement(query)) {
            return RecordedQueryResult.failed("One statement at a time - remove the ';' in the middle.");
        }
        try (Connection c = DriverManager.getConnection("jdbc:sqlite::memory:")) {
            load(c, table, columns, rows);
            try (Statement s = c.createStatement()) {
                s.execute("PRAGMA query_only = ON");
            }
            long deadline = System.currentTimeMillis() + TIMEOUT_MILLIS;
            ProgressHandler.setHandler(c, 1000, new ProgressHandler() {
                @Override
                protected int progress() {
                    return System.currentTimeMillis() > deadline ? 1 : 0;
                }
            });
            long total;
            try (PreparedStatement ps = c.prepareStatement("SELECT COUNT(*) FROM (" + query + ")")) {
                bind(ps, params, 0);
                try (ResultSet rs = ps.executeQuery()) {
                    total = rs.next() ? rs.getLong(1) : 0;
                }
            }
            List<String> resultColumns = new ArrayList<>();
            List<List<String>> page = new ArrayList<>();
            Set<Integer> seqs = null;
            try (PreparedStatement ps = c.prepareStatement("SELECT * FROM (" + query + ") LIMIT ? OFFSET ?")) {
                int next = bind(ps, params, 0);
                ps.setInt(next + 1, limit);
                ps.setInt(next + 2, offset);
                try (ResultSet rs = ps.executeQuery()) {
                    ResultSetMetaData meta = rs.getMetaData();
                    for (int i = 1; i <= meta.getColumnCount(); i++) {
                        resultColumns.add(meta.getColumnLabel(i));
                    }
                    while (rs.next()) {
                        List<String> row = new ArrayList<>();
                        for (int i = 1; i <= resultColumns.size(); i++) {
                            row.add(rs.getString(i));
                        }
                        page.add(row);
                    }
                }
            }
            int n = indexOfIgnoreCase(resultColumns, "n");
            if (n >= 0 && "statements".equals(table)) {
                seqs = new LinkedHashSet<>();
                try (PreparedStatement ps = c.prepareStatement("SELECT * FROM (" + query + ") LIMIT " + MAX_RESULT_ROWS)) {
                    bind(ps, params, 0);
                    try (ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) {
                            seqs.add(rs.getInt(n + 1));
                        }
                    }
                }
            }
            return new RecordedQueryResult(resultColumns, page, Math.min(total, MAX_RESULT_ROWS), seqs == null ? null : new ArrayList<>(seqs), null);
        } catch (SQLException e) {
            return RecordedQueryResult.failed(friendly(e, columns));
        }
    }

    private static void load(Connection c, String table, List<String> columns, List<List<Object>> rows) throws SQLException {
        StringBuilder ddl = new StringBuilder("CREATE TABLE ").append(quote(table)).append(" (");
        StringBuilder insert = new StringBuilder("INSERT INTO ").append(quote(table)).append(" VALUES (");
        for (int i = 0; i < columns.size(); i++) {
            ddl.append(i == 0 ? "" : ", ").append(quote(columns.get(i)));
            insert.append(i == 0 ? "?" : ", ?");
        }
        ddl.append(")");
        insert.append(")");
        try (Statement s = c.createStatement()) {
            s.execute(ddl.toString());
        }
        if (columns.isEmpty()) {
            return;
        }
        c.setAutoCommit(false);
        try (PreparedStatement ps = c.prepareStatement(insert.toString())) {
            for (List<Object> row : rows) {
                for (int i = 0; i < columns.size(); i++) {
                    ps.setObject(i + 1, i < row.size() ? row.get(i) : null);
                }
                ps.addBatch();
            }
            ps.executeBatch();
        }
        c.commit();
        c.setAutoCommit(true);
    }

    private static int bind(PreparedStatement ps, List<Object> params, int from) throws SQLException {
        for (int i = 0; i < params.size(); i++) {
            ps.setObject(from + i + 1, params.get(i));
        }
        return from + params.size();
    }

    static String stripTrailingSemicolon(String sql) {
        String s = sql == null ? "" : sql.strip();
        while (s.endsWith(";")) {
            s = s.substring(0, s.length() - 1).strip();
        }
        return s;
    }

    /** A ';' outside string literals and comments means a second statement. */
    static boolean hasSecondStatement(String sql) {
        boolean inString = false;
        for (int i = 0; i < sql.length(); i++) {
            char ch = sql.charAt(i);
            if (inString) {
                if (ch == '\'') {
                    inString = false;
                }
            } else if (ch == '\'') {
                inString = true;
            } else if (ch == '-' && i + 1 < sql.length() && sql.charAt(i + 1) == '-') {
                int end = sql.indexOf('\n', i);
                i = end < 0 ? sql.length() : end;
            } else if (ch == ';') {
                return true;
            }
        }
        return false;
    }

    private static String friendly(SQLException e, List<String> columns) {
        String message = e.getMessage() == null ? "The query failed." : e.getMessage();
        if (message.contains("interrupted")) {
            return "The query took longer than 3 s and was stopped.";
        }
        if (message.contains("attempt to write a readonly database")) {
            return "Only reading is allowed here.";
        }
        Matcher m = NO_COLUMN.matcher(message);
        if (m.find()) {
            return "No column \"" + m.group(1) + "\". Columns: " + String.join(", ", columns);
        }
        String cleaned = message.replaceFirst("^\\[SQLITE_[A-Z_]+\\][^(]*\\(", "").replaceFirst("\\)$", "");
        return cleaned.isBlank() ? message : cleaned;
    }

    private static int indexOfIgnoreCase(List<String> names, String name) {
        for (int i = 0; i < names.size(); i++) {
            if (names.get(i).toLowerCase(Locale.ROOT).equals(name)) {
                return i;
            }
        }
        return -1;
    }

    static String quote(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }
}
