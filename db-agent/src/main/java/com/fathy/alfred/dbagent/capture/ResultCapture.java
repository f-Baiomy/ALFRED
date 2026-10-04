package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.transport.Value;
import com.fathy.alfred.dbagent.values.ValueCodec;

import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Rows of one result set, recorded AS THE APPLICATION READS THEM (research D7): a row starts on next() returning
 * true, a cell is filled when a get* returns it. The agent never reads ahead and never reads a column the
 * application did not - so cursor position, fetch behaviour and driver streams are exactly what they were without it.
 */
final class ResultCapture {

    enum Mode { ROWS, KEYS }

    static final Value NOT_READ = new Value("NOT_READ", null, true, null, null);

    final PendingStatement pending;
    final Mode mode;
    private final int limit;
    private String[][] columns;
    private Map<String, Integer> byLabel;
    private Value[] row;
    private int lastIndex = -1;
    boolean exhausted;
    final List<List<Value>> keys = new ArrayList<>();

    ResultCapture(PendingStatement pending, Mode mode, int limit) {
        this.pending = pending;
        this.mode = mode;
        this.limit = limit;
    }

    void ensureColumns(Object resultSet) {
        if (columns != null) {
            return;
        }
        try {
            ResultSetMetaData meta = ((ResultSet) resultSet).getMetaData();
            int n = meta.getColumnCount();
            columns = new String[n][];
            byLabel = new HashMap<>();
            for (int i = 1; i <= n; i++) {
                String label = meta.getColumnLabel(i);
                columns[i - 1] = new String[]{label, meta.getColumnTypeName(i)};
                byLabel.putIfAbsent(label.toLowerCase(Locale.ROOT), i);
            }
        } catch (Throwable t) {
            columns = new String[0][];
            byLabel = new HashMap<>();
        }
        if (mode == Mode.ROWS) {
            List<String[]> list = new ArrayList<>();
            for (String[] c : columns) {
                list.add(c);
            }
            synchronized (pending) {
                pending.outcome.columns = list;
            }
        }
    }

    /** next() returned true. */
    void startRow(Object resultSet, Recorder recorder) {
        ensureColumns(resultSet);
        commitRow(recorder);
        row = new Value[columns.length];
        synchronized (pending) {
            if (mode == Mode.ROWS) {
                pending.rowsRead++;
            }
            pending.lastActivityNanos = System.nanoTime();
        }
    }

    void cell(Object resultSet, Object columnRef, String method, Object value) {
        if (row == null) {
            return;
        }
        int index = indexOf(columnRef);
        if (index < 1 || index > row.length) {
            return;
        }
        row[index - 1] = ValueCodec.column(columns[index - 1][1], method, value);
        lastIndex = index - 1;
    }

    void lastWasNull() {
        if (row != null && lastIndex >= 0 && row[lastIndex] != null) {
            row[lastIndex] = new Value(row[lastIndex].type, null, false, null, null);
        }
    }

    private int indexOf(Object columnRef) {
        if (columnRef instanceof Integer) {
            return (Integer) columnRef;
        }
        if (columnRef instanceof String && byLabel != null) {
            String label = (String) columnRef;
            int dot = label.lastIndexOf('.');
            Integer i = byLabel.get(label.toLowerCase(Locale.ROOT));
            if (i == null && dot >= 0) {
                i = byLabel.get(label.substring(dot + 1).toLowerCase(Locale.ROOT));
            }
            return i == null ? -1 : i;
        }
        return -1;
    }

    /** Moves the finished row into the pending statement (or the generated keys); sends a chunk every 500 rows. */
    void commitRow(Recorder recorder) {
        if (row == null) {
            return;
        }
        List<Value> values = new ArrayList<>(row.length);
        for (Value v : row) {
            // A column the application never read: kept distinct from SQL NULL, never fetched by the agent.
            values.add(v == null ? NOT_READ : v);
        }
        row = null;
        lastIndex = -1;
        if (mode == Mode.KEYS) {
            keys.add(values);
            return;
        }
        boolean chunk;
        synchronized (pending) {
            if (pending.rowsSent + pending.rows.size() >= limit) {
                pending.outcome.overLimit = Boolean.TRUE;
                return;
            }
            pending.rows.add(values);
            chunk = pending.rows.size() >= PendingStatement.CHUNK_ROWS;
        }
        if (chunk) {
            recorder.chunk(pending);
        }
    }
}
