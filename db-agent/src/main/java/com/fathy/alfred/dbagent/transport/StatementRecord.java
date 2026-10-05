package com.fathy.alfred.dbagent.transport;

import java.util.List;

/**
 * One statement (or one continuation chunk of a long result - same {@code sid}, {@code rowsFrom} &gt; 0) as it leaves
 * the agent. Built on the application thread, serialised on the sender thread.
 */
public final class StatementRecord {
    public String sid;
    public String callId;
    public String runTag;
    public String thread;
    public int seq;
    public String kind;
    public String sql;
    public String fingerprint;
    public String table;
    public List<List<Value>> params;
    public Outcome outcome;
    public List<List<Value>> rows;
    public int rowsFrom;
    public List<List<Value>> beforeImageRows;
    public BeforeImageInfo beforeImage;
    public String startedAt;
    public long durationMicros;
    public long offsetMicros;
    public String txId;
    public String connectionId;
    public String codeLocation;
    /** The application's call chain: up to N frames past the project's pass-through classes, innermost first. */
    public List<String> callers;
    /** The table's indexes - on the first statement of each table in a call, when the project's Index check is on. */
    public List<IndexRecord> indexes;
    public String dataSource;
    public List<String> cascadesTo;
    /** The ORM query or event that made this statement; null for plain JDBC. */
    public OriginRecord origin;

    public long approxBytes() {
        long bytes = 200 + (sql == null ? 0 : sql.length()) + (origin == null || origin.text == null ? 0 : origin.text.length());
        bytes += valuesBytes(params) + valuesBytes(rows) + valuesBytes(beforeImageRows);
        return bytes;
    }

    private static long valuesBytes(List<List<Value>> rows) {
        if (rows == null) {
            return 0;
        }
        long bytes = 0;
        for (List<Value> row : rows) {
            for (Value v : row) {
                bytes += v == null ? 8 : v.approxBytes();
            }
        }
        return bytes;
    }

    /** Where an UPDATE/DELETE's before rows came from - see backend-db-capture's BeforeImage. */
    public static final class BeforeImageInfo {
        public String source;
        public Long extraReadMicros;
        public String skippedReason;
        public Integer rowCount;
        public List<String[]> columns;
    }
}
