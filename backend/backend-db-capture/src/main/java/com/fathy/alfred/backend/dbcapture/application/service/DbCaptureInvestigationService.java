package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.in.InvestigateCallUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.QuerySandboxPort;
import com.fathy.alfred.backend.dbcapture.domain.model.CapturedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.Column;
import com.fathy.alfred.backend.dbcapture.domain.model.OutcomeKind;
import com.fathy.alfred.backend.dbcapture.domain.model.RecordedQueryRequest;
import com.fathy.alfred.backend.dbcapture.domain.model.RecordedQueryResult;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;
import com.fathy.alfred.backend.dbcapture.domain.model.TableSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.TraceHit;
import com.fathy.alfred.backend.dbcapture.domain.model.TypedValue;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Search, SQL, tracing and per-table totals over what a call RECORDED. Queries run in QuerySandboxPort's throwaway
 * in-memory database, never against db-capture.db and never against the application's database. A query over rows
 * sees at most the rows stored for that statement (the per-result limit), which the window says.
 */
@Service
public class DbCaptureInvestigationService implements InvestigateCallUseCase {

    static final String RESULT_TABLE = "result";
    static final String STATEMENTS_TABLE = "statements";
    static final List<String> STATEMENT_COLUMNS = List.of("n", "verb", "table", "sql", "ms", "rows", "tx", "write", "failed", "offset", "code");
    static final int MAX_STATEMENTS = 50_000;
    static final int MAX_TRACE_HITS = 500;

    private final DbCaptureStorePort store;
    private final QuerySandboxPort sandbox;

    /** Redis hits join the trace (specs/011-redis-capture FR-026). Optional for tests built before it. */
    private StoreCommandsService storeCommands;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setStoreCommands(StoreCommandsService storeCommands) {
        this.storeCommands = storeCommands;
    }

    public DbCaptureInvestigationService(DbCaptureStorePort store, QuerySandboxPort sandbox) {
        this.store = store;
        this.sandbox = sandbox;
    }

    @Override
    public Optional<RecordedQueryResult> queryRows(long statementId, String part, RecordedQueryRequest request) {
        String safePart = "BEFORE_IMAGE".equals(part) ? "BEFORE_IMAGE" : "RESULT";
        return store.statement(statementId).map(statement -> {
            List<Column> columns = store.columns(statementId, safePart);
            List<List<TypedValue>> stored = store.rows(statementId, safePart, 0, Integer.MAX_VALUE);
            List<String> names = uniqueNames(columns, stored.isEmpty() ? 0 : stored.get(0).size());
            List<List<Object>> rows = stored.stream().map(r -> r.stream().map(DbCaptureInvestigationService::sqlValue).toList()).toList();
            return run(RESULT_TABLE, names, rows, request);
        });
    }

    @Override
    public RecordedQueryResult queryStatements(String callId, RecordedQueryRequest request) {
        List<List<Object>> rows = new ArrayList<>();
        for (CapturedStatement s : store.allStatements(callId, MAX_STATEMENTS)) {
            List<Object> row = new ArrayList<>();
            row.add(s.seq());
            row.add(verbOf(s));
            row.add(s.table());
            row.add(s.sql());
            row.add(Math.round(s.durationMicros() / 100.0) / 10.0);
            row.add(rowCount(s));
            row.add(s.txId());
            row.add(isWrite(s) ? 1 : 0);
            row.add(s.outcome().kind() == OutcomeKind.FAILED ? 1 : 0);
            row.add(Math.round(s.offsetMicros() / 1000.0));
            row.add(s.codeLocation());
            rows.add(row);
        }
        return run(STATEMENTS_TABLE, STATEMENT_COLUMNS, rows, request);
    }

    private RecordedQueryResult run(String table, List<String> columns, List<List<Object>> rows, RecordedQueryRequest request) {
        int limit = Math.max(1, Math.min(MAX_PAGE, request.limit() <= 0 ? 100 : request.limit()));
        int offset = Math.max(0, request.offset());
        if (request.isSql()) {
            String sql = request.text() == null ? "" : request.text().strip();
            if (sql.isEmpty()) {
                return RecordedQueryResult.failed("Write a SELECT over the table " + table + ".");
            }
            return sandbox.run(table, columns, rows, sql, List.of(), offset, limit);
        }
        // Search: any column contains the text; optional sort - generated, with bound parameters.
        StringBuilder sql = new StringBuilder("SELECT * FROM ").append(table);
        List<Object> params = new ArrayList<>();
        String text = request.text() == null ? "" : request.text().strip();
        if (!text.isEmpty()) {
            sql.append(" WHERE ");
            for (int i = 0; i < columns.size(); i++) {
                sql.append(i == 0 ? "" : " OR ").append("CAST(").append(quote(columns.get(i))).append(" AS TEXT) LIKE ? ESCAPE '!'");
                params.add("%" + text.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%");
            }
        }
        if (request.sortColumn() != null && columns.contains(request.sortColumn())) {
            sql.append(" ORDER BY ").append(quote(request.sortColumn())).append("desc".equalsIgnoreCase(request.sortDir()) ? " DESC" : " ASC");
        }
        return sandbox.run(table, columns, rows, sql.toString(), params, offset, limit);
    }

    @Override
    public List<TraceHit> trace(String callId, String value) {
        if (value == null || value.isEmpty()) {
            return List.of();
        }
        List<TraceHit> hits = new ArrayList<>();
        for (CapturedStatement s : store.allStatements(callId, MAX_STATEMENTS)) {
            for (List<TypedValue> set : s.params()) {
                for (int i = 0; i < set.size(); i++) {
                    if (value.equals(set.get(i).value())) {
                        hits.add(new TraceHit(s.seq(), "OUT".equals(set.get(i).direction()) ? TraceHit.OUT : TraceHit.PARAM, i, null));
                    }
                }
            }
            if (s.outcome().generatedKeys() != null) {
                for (List<TypedValue> key : s.outcome().generatedKeys()) {
                    for (int i = 0; i < key.size(); i++) {
                        if (value.equals(key.get(i).value())) {
                            hits.add(new TraceHit(s.seq(), TraceHit.KEY, i, null));
                        }
                    }
                }
            }
            if (s.outcome().outParams() != null) {
                for (int i = 0; i < s.outcome().outParams().size(); i++) {
                    if (value.equals(s.outcome().outParams().get(i).value())) {
                        hits.add(new TraceHit(s.seq(), TraceHit.OUT, i, null));
                    }
                }
            }
            if (hits.size() >= MAX_TRACE_HITS) {
                break;
            }
        }
        hits.addAll(store.rowsContaining(callId, value, MAX_TRACE_HITS));
        if (storeCommands != null) {
            hits.addAll(storeCommands.trace(callId, value, MAX_TRACE_HITS));
        }
        hits.sort((a, b) -> a.seq() != b.seq() ? Integer.compare(a.seq(), b.seq()) : a.where().compareTo(b.where()));
        return hits.size() > MAX_TRACE_HITS ? hits.subList(0, MAX_TRACE_HITS) : hits;
    }

    @Override
    public List<TableSummary> tables(String callId) {
        Map<String, long[]> by = new LinkedHashMap<>();
        for (CapturedStatement s : store.allStatements(callId, MAX_STATEMENTS)) {
            if (s.kind() == StatementKind.COMMIT || s.kind() == StatementKind.ROLLBACK || s.kind() == StatementKind.SAVEPOINT
                    || s.kind() == StatementKind.ROLLBACK_TO_SAVEPOINT) {
                continue;
            }
            String table = (s.table() == null ? "(no table)" : s.table()) + (s.kind() == StatementKind.CALL ? " (procedure)" : "");
            long[] t = by.computeIfAbsent(table, k -> new long[7]);
            if (s.outcome().kind() == OutcomeKind.FAILED) {
                t[4]++;
            } else if (s.kind() == StatementKind.INSERT || s.kind() == StatementKind.MERGE) {
                t[1] += Math.max(1, s.params().size());
            } else if (s.kind() == StatementKind.UPDATE) {
                t[2]++;
            } else if (s.kind() == StatementKind.DELETE) {
                t[3] += s.outcome().affected() == null ? 0 : s.outcome().affected();
            } else {
                t[0]++;
            }
            t[5] += s.outcome().rowsRead() == null ? 0 : s.outcome().rowsRead();
            t[6] += s.durationMicros();
        }
        List<TableSummary> out = new ArrayList<>();
        by.forEach((table, t) -> out.add(new TableSummary(table, (int) t[0], (int) t[1], (int) t[2], t[3], (int) t[4], t[5], t[6])));
        // What changed first (writes, deletes, failures), then by time - the mock's order.
        out.sort((a, b) -> {
            long wa = a.inserts() + a.updates() + a.deletedRows() + a.failed();
            long wb = b.inserts() + b.updates() + b.deletedRows() + b.failed();
            return wa != wb ? Long.compare(wb, wa) : Long.compare(b.micros(), a.micros());
        });
        return out;
    }

    /** Column names as the query sees them: lower-case-insensitive duplicates get a suffix, blanks a position name. */
    static List<String> uniqueNames(List<Column> columns, int width) {
        List<String> names = new ArrayList<>();
        int n = Math.max(columns.size(), width);
        for (int i = 0; i < n; i++) {
            String base = i < columns.size() && columns.get(i).name() != null && !columns.get(i).name().isBlank()
                    ? columns.get(i).name() : "col" + (i + 1);
            String name = base;
            int k = 2;
            while (containsIgnoreCase(names, name)) {
                name = base + "_" + k++;
            }
            names.add(name);
        }
        return names;
    }

    private static boolean containsIgnoreCase(List<String> names, String name) {
        return names.stream().anyMatch(x -> x.equalsIgnoreCase(name));
    }

    /** Numbers become numbers so "amount > 500" compares numerically; everything else stays text; NULL stays NULL. */
    static Object sqlValue(TypedValue v) {
        if (v == null || v.value() == null || "NOT_READ".equals(v.type())) {
            return null;
        }
        String raw = v.value();
        if (raw.matches("-?\\d{1,18}")) {
            return Long.parseLong(raw);
        }
        if (raw.matches("-?\\d+\\.\\d+([eE][-+]?\\d+)?")) {
            try {
                return Double.parseDouble(raw);
            } catch (NumberFormatException e) {
                return raw;
            }
        }
        return raw;
    }

    static String quote(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    private static String verbOf(CapturedStatement s) {
        return s.outcome().kind() == OutcomeKind.FAILED ? "FAILED" : s.kind().name().toUpperCase(Locale.ROOT);
    }

    private static boolean isWrite(CapturedStatement s) {
        return s.kind() == StatementKind.INSERT || s.kind() == StatementKind.UPDATE || s.kind() == StatementKind.DELETE
                || s.kind() == StatementKind.MERGE;
    }

    private static long rowCount(CapturedStatement s) {
        if (s.outcome().rowsRead() != null) {
            return s.outcome().rowsRead();
        }
        return s.outcome().affected() == null ? 0 : s.outcome().affected();
    }
}
