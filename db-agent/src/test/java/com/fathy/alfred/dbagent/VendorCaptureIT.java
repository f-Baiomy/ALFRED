package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.transport.StatementRecord;
import com.fathy.alfred.dbagent.transport.Value;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.Date;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.util.List;
import java.util.UUID;

import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static com.fathy.alfred.dbagent.AgentTestSupport.inCall;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * SC-010 against the real databases: PostgreSQL, MySQL, SQL Server and Oracle. Runs only with the {@code vendors}
 * Maven profile and a {@code VENDOR_<DB>_URL} environment variable per database (user and password in the URL or in
 * {@code VENDOR_<DB>_USER}/{@code _PASSWORD}); otherwise each test is skipped. For every common column type it checks
 * that the captured value is readable text (not an opaque vendor object), that parameters, rows, an UPDATE, a DELETE
 * and a failure are all recorded, and prints what was captured - the table in docs/db-capture.md.
 */
class VendorCaptureIT {

    private static Connection connect(String db) throws SQLException {
        String url = System.getenv("VENDOR_" + db + "_URL");
        Assumptions.assumeTrue(url != null && !url.isEmpty(), "VENDOR_" + db + "_URL not set");
        String user = System.getenv("VENDOR_" + db + "_USER");
        return user == null ? DriverManager.getConnection(url) : DriverManager.getConnection(url, user, System.getenv("VENDOR_" + db + "_PASSWORD"));
    }

    private static void exec(Connection c, String... sql) throws SQLException {
        try (Statement s = c.createStatement()) {
            for (String one : sql) {
                try {
                    s.execute(one);
                } catch (SQLException e) {
                    if (!one.startsWith("DROP")) {
                        throw e;
                    }
                }
            }
        }
    }

    private void run(String db, String ddl, String insert, String select) throws Exception {
        String table = "alfred_vt";
        AgentTestSupport.reset();
        String callId = "vendor-" + db.toLowerCase();
        UUID uid = UUID.fromString("5f0c6e2a-8a1e-4c4f-9d1b-2f7d3c9a0b11");
        inCall(callId, () -> {
            try (Connection c = connect(db)) {
                exec(c, "DROP TABLE " + table, ddl.replace("{t}", table));
                try (PreparedStatement ps = c.prepareStatement(insert.replace("{t}", table))) {
                    ps.setLong(1, 1042L);
                    ps.setBigDecimal(2, new BigDecimal("120.50"));
                    ps.setString(3, "O'Brien");
                    ps.setString(4, "a long note");
                    ps.setTimestamp(5, Timestamp.valueOf("2026-10-04 18:02:43.456"));
                    ps.setDate(6, Date.valueOf("2026-10-04"));
                    ps.setBoolean(7, true);
                    ps.setBytes(8, new byte[]{1, 2, 3, 4});
                    if (db.equals("PG")) {
                        ps.setObject(9, uid);
                    } else if (db.equals("ORACLE")) {
                        ps.setBytes(9, new byte[16]);
                    } else {
                        ps.setString(9, uid.toString());
                    }
                    ps.setString(10, "{\"chargeId\":\"CHG-88213\"}");
                    ps.executeUpdate();
                }
                try (PreparedStatement ps = c.prepareStatement(select.replace("{t}", table))) {
                    ps.setLong(1, 1042L);
                    try (ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) {
                            for (int i = 1; i <= rs.getMetaData().getColumnCount(); i++) {
                                rs.getObject(i);
                            }
                        }
                    }
                }
                try (PreparedStatement ps = c.prepareStatement("UPDATE " + table + " SET amount = ? WHERE id = ?")) {
                    ps.setBigDecimal(1, new BigDecimal("380.00"));
                    ps.setLong(2, 1042L);
                    ps.executeUpdate();
                }
                try (PreparedStatement ps = c.prepareStatement("INSERT INTO " + table + " (id) VALUES (?)")) {
                    ps.setLong(1, 1042L); // duplicate key - a failure to capture
                    ps.executeUpdate();
                } catch (SQLException expected) {
                    // the application would handle it; the agent must have recorded it
                }
                try (PreparedStatement ps = c.prepareStatement("DELETE FROM " + table + " WHERE id = ?")) {
                    ps.setLong(1, 1042L);
                    ps.executeUpdate();
                }
                exec(c, "DROP TABLE " + table);
            }
        }, true);

        List<StatementRecord> records = SINK.statementsOf(callId);
        StatementRecord insertRecord = records.stream().filter(r -> "INSERT".equals(r.kind) && "UPDATED".equals(r.outcome.kind)).findFirst().orElseThrow(AssertionError::new);
        StatementRecord selectRecord = records.stream().filter(r -> "SELECT".equals(r.kind)).findFirst().orElseThrow(AssertionError::new);
        assertThat(selectRecord.rows).hasSize(1);
        System.out.println("[vendor] " + db + " - " + selectRecord.dataSource);
        List<Value> row = selectRecord.rows.get(0);
        for (int i = 0; i < row.size(); i++) {
            Value v = row.get(i);
            System.out.printf("[vendor] %-7s %-10s %-22s %s%s%n", db, selectRecord.outcome.columns.get(i)[0], v.type, v.value,
                    v.opaque ? "   <-- OPAQUE" : "");
            assertThat(v.opaque).as(db + " column " + selectRecord.outcome.columns.get(i)[0] + " (" + v.type + ") is opaque: " + v.value).isFalse();
            assertThat(v.value).as(db + " column " + selectRecord.outcome.columns.get(i)[0]).isNotNull();
        }
        for (Value p : insertRecord.params.get(0)) {
            System.out.printf("[vendor] %-7s param      %-22s %s%n", db, p.type, p.value);
        }
        assertThat(records.stream().filter(r -> "UPDATE".equals(r.kind)).findFirst().orElseThrow(AssertionError::new).outcome.affected).isEqualTo(1L);
        StatementRecord failure = records.stream().filter(r -> "FAILED".equals(r.outcome.kind) && "INSERT".equals(r.kind)).findFirst()
                .orElseThrow(AssertionError::new);
        System.out.println("[vendor] " + db + " failure: SQLState " + failure.outcome.sqlState + " / " + failure.outcome.vendorCode + " - " + failure.outcome.message);
        assertThat(failure.outcome.message).isNotBlank();
        assertThat(records.stream().filter(r -> "DELETE".equals(r.kind)).findFirst().orElseThrow(AssertionError::new).outcome.affected).isEqualTo(1L);
    }

    private static final String INSERT = "INSERT INTO {t} (id, amount, name, note, created, day, active, data, ref_id, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    private static final String SELECT = "SELECT id, amount, name, note, created, day, active, data, ref_id, doc FROM {t} WHERE id = ?";

    @Test
    void postgresql() throws Exception {
        run("PG", "CREATE TABLE {t} (id BIGINT PRIMARY KEY, amount NUMERIC(12,2), name VARCHAR(50), note TEXT, created TIMESTAMP, day DATE, "
                + "active BOOLEAN, data BYTEA, ref_id UUID, doc JSONB)", INSERT.replace("?)", "CAST(? AS JSONB))"), SELECT);
    }

    @Test
    void mysql() throws Exception {
        run("MYSQL", "CREATE TABLE {t} (id BIGINT PRIMARY KEY, amount DECIMAL(12,2), name VARCHAR(50), note TEXT, created DATETIME(3), day DATE, "
                + "active BOOLEAN, data BLOB, ref_id CHAR(36), doc JSON)", INSERT, SELECT);
    }

    @Test
    void sqlServer() throws Exception {
        run("MSSQL", "CREATE TABLE {t} (id BIGINT PRIMARY KEY, amount DECIMAL(12,2), name NVARCHAR(50), note NVARCHAR(MAX), created DATETIME2, "
                + "day DATE, active BIT, data VARBINARY(MAX), ref_id UNIQUEIDENTIFIER, doc NVARCHAR(MAX))", INSERT, SELECT);
    }

    @Test
    void oracle() throws Exception {
        run("ORACLE", "CREATE TABLE {t} (id NUMBER(19) PRIMARY KEY, amount NUMBER(12,2), name VARCHAR2(50), note CLOB, created TIMESTAMP, "
                + "day DATE, active NUMBER(1), data BLOB, ref_id RAW(16), doc CLOB)", INSERT, SELECT);
    }
}
