package com.fathy.alfred.dbagent.jdbc;

import com.fathy.alfred.dbagent.sql.WriteShape;
import com.fathy.alfred.dbagent.transport.StatementRecord;
import com.fathy.alfred.dbagent.transport.Value;
import com.fathy.alfred.dbagent.values.ValueCodec;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The opt-in before-image (FR-018): for a table the user listed, just before an UPDATE or DELETE runs, read the rows
 * it is about to change - {@code SELECT * FROM <table> WHERE <the same where>} with the same bound values, on the same
 * connection, so inside the same transaction. It is the ONLY time the agent ever sends a statement of its own, and
 * only for tables the user named; it never changes anything, and a failure here is recorded as the skip reason and
 * never reaches the application.
 */
public final class BeforeImageReader {

    private BeforeImageReader() {
    }

    /**
     * Reads into {@code rowsOut} (at most {@code maxRows}) and returns what to store with the statement.
     * {@code boundValues}: the statement's parameters by JDBC index (1-based Integer keys), as the application set them.
     */
    public static StatementRecord.BeforeImageInfo read(Connection connection, String sql, Map<Object, Object> boundValues, int maxRows,
                                                       List<List<Value>> rowsOut) {
        StatementRecord.BeforeImageInfo info = new StatementRecord.BeforeImageInfo();
        WriteShape.Result shape = WriteShape.of(sql);
        if (shape.shape == null) {
            info.source = "NONE";
            info.skippedReason = shape.reason;
            return info;
        }
        WriteShape w = shape.shape;
        long start = System.nanoTime();
        try (PreparedStatement ps = connection.prepareStatement("SELECT * FROM " + w.fromClause + " WHERE " + w.where)) {
            for (int i = 0; i < w.whereParamCount; i++) {
                Integer index = w.firstWhereParam + i + 1;
                if (!boundValues.containsKey(index)) {
                    info.source = "NONE";
                    info.skippedReason = "parameter ?" + index + " was not set in a way the agent could reuse";
                    return info;
                }
                ps.setObject(i + 1, boundValues.get(index));
            }
            ps.setMaxRows(maxRows + 1);
            try (ResultSet rs = ps.executeQuery()) {
                ResultSetMetaData meta = rs.getMetaData();
                int n = meta.getColumnCount();
                List<String[]> columns = new ArrayList<>(n);
                for (int i = 1; i <= n; i++) {
                    columns.add(new String[]{meta.getColumnLabel(i), meta.getColumnTypeName(i)});
                }
                int count = 0;
                while (rs.next()) {
                    count++;
                    if (count > maxRows) {
                        continue;
                    }
                    List<Value> row = new ArrayList<>(n);
                    for (int i = 1; i <= n; i++) {
                        row.add(ValueCodec.column(columns.get(i - 1)[1], "getObject", rs.getObject(i)));
                    }
                    rowsOut.add(row);
                }
                info.source = "AGENT_READ";
                info.columns = columns;
                info.rowCount = rowsOut.size();
            }
        } catch (Throwable t) {
            rowsOut.clear();
            info.source = "NONE";
            info.skippedReason = "the before-image read failed: " + t.getClass().getSimpleName();
        } finally {
            info.extraReadMicros = (System.nanoTime() - start) / 1000;
        }
        return info;
    }
}
