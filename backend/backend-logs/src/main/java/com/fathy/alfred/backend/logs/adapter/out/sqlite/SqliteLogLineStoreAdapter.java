package com.fathy.alfred.backend.logs.adapter.out.sqlite;

import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogQueryTranslator.Sql;
import com.fathy.alfred.backend.logs.application.port.out.LogLineStorePort;
import com.fathy.alfred.backend.logs.domain.ingest.GroupKeyer;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.FieldStats;
import com.fathy.alfred.backend.logs.domain.model.FieldType;
import com.fathy.alfred.backend.logs.domain.model.FieldValues;
import com.fathy.alfred.backend.logs.domain.model.GroupNode;
import com.fathy.alfred.backend.logs.domain.model.GroupSort;
import com.fathy.alfred.backend.logs.domain.model.Histogram;
import com.fathy.alfred.backend.logs.domain.model.LineRecord;
import com.fathy.alfred.backend.logs.domain.model.LineShape;
import com.fathy.alfred.backend.logs.domain.model.LogLine;
import com.fathy.alfred.backend.logs.domain.model.LogLineSummary;
import com.fathy.alfred.backend.logs.domain.model.LogPage;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.Minimap;
import com.fathy.alfred.backend.logs.domain.model.Pattern;
import com.fathy.alfred.backend.logs.domain.model.SearchMode;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.stream.Collectors;

/**
 * SQLite implementation of every line read/write (research §R2-§R9). Every list query is
 * keyset-paged with a LIMIT; aggregates return bounded result sets; the raw line is only read by
 * {@link #get} (constitution II: summaries for lists).
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.logs", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteLogLineStoreAdapter implements LogLineStorePort {

    /** Sibling / level-skipping lines returned with one group node. */
    static final int NODE_LINES = 1_000;
    /** Group nodes summed in memory before a flush while rebuilding the group table. */
    static final int REBUILD_FLUSH_NODES = 100_000;
    private static final String BASE_COLS = "rid, line_id, input_id, byte_offset, ts_ms, level, group_level, group_path, "
            + "missing_level, pinned, unparsed, shape";

    private final SqliteLogsRepository repository;
    /** Column names per line table; DDL only ever adds, so caching what exists is safe. */
    private final Map<String, Set<String>> columns = new ConcurrentHashMap<>();
    /** Structures per source: read on every list request (summary fields), written once per batch. */
    private final Map<String, List<LineShape>> shapeCache = new ConcurrentHashMap<>();

    public SqliteLogLineStoreAdapter(SqliteLogsRepository repository) {
        this.repository = repository;
    }

    private JdbcTemplate jdbc() {
        return repository.jdbc();
    }

    // ------------------------------------------------------------------ DDL

    @Override
    public void createSource(String sourceId) {
        repository.createSourceTables(sourceId);
        columns.remove(sourceId);
    }

    @Override
    public void dropSource(String sourceId) {
        repository.dropSourceTables(sourceId);
        columns.remove(sourceId);
        shapeCache.remove(sourceId);
    }

    private Set<String> columnsOf(String sourceId) {
        return columns.computeIfAbsent(sourceId, id -> new HashSet<>(jdbc().queryForList(
                "SELECT name FROM pragma_table_info('" + SqliteLogsRepository.lines(id) + "')", String.class)));
    }

    @Override
    public synchronized void ensureFields(String sourceId, List<FieldDef> fields) {
        Set<String> have = columnsOf(sourceId);
        String ll = SqliteLogsRepository.lines(sourceId);
        for (FieldDef f : fields) {
            if (!f.stored()) {
                continue;
            }
            if (have.add(SqliteLogQueryTranslator.text(f))) {
                jdbc().execute("ALTER TABLE " + ll + " ADD COLUMN " + SqliteLogQueryTranslator.text(f) + " TEXT");
            }
            if (f.typed() && have.add(SqliteLogQueryTranslator.typedCol(f))) {
                jdbc().execute("ALTER TABLE " + ll + " ADD COLUMN " + SqliteLogQueryTranslator.typedCol(f));
            }
        }
    }

    @Override
    public void setIndex(String sourceId, FieldDef field, boolean indexed) {
        String ll = SqliteLogsRepository.lines(sourceId);
        String name = "ix_" + ll + "_f" + field.index();
        jdbc().execute("DROP INDEX IF EXISTS " + name);
        if (indexed) {
            ensureFields(sourceId, List.of(field));
            jdbc().execute("CREATE INDEX " + name + " ON " + ll + "(" + SqliteLogQueryTranslator.valueCol(field) + ")");
        }
    }

    // ------------------------------------------------------------------ ingest

    @Override
    public int append(String sourceId, LogStructure structure, Batch batch) {
        String ll = SqliteLogsRepository.lines(sourceId);
        List<FieldDef> stored = structure.fields().stream().filter(FieldDef::stored).toList();
        ensureFields(sourceId, stored);
        Set<String> have = columnsOf(sourceId);
        List<FieldDef> typed = stored.stream().filter(f -> have.contains(SqliteLogQueryTranslator.typedCol(f))).toList();

        StringBuilder cols = new StringBuilder("rid, line_id, input_id, byte_offset, ts_ms, ingested_ms, level, group_level, group_path, "
                + "missing_level, pattern_id, duration, unparsed, shape, bytes, raw");
        stored.forEach(f -> cols.append(", ").append(SqliteLogQueryTranslator.text(f)));
        typed.forEach(f -> cols.append(", ").append(SqliteLogQueryTranslator.typedCol(f)));
        int n = 16 + stored.size() + typed.size();
        String insert = "INSERT INTO " + ll + " (" + cols + ") VALUES (" + String.join(",", Collections.nCopies(n, "?")) + ")";
        long now = System.currentTimeMillis();
        int inserted = 0;
        long bytes = 0;
        long unparsed = 0;
        try (Connection c = repository.dataSource().getConnection()) {
            c.setAutoCommit(false);
            try (PreparedStatement ins = c.prepareStatement(insert);
                 PreparedStatement fts = c.prepareStatement("INSERT INTO " + SqliteLogsRepository.fts(sourceId) + " (rowid, txt) VALUES (?, ?)");
                 PreparedStatement pat = c.prepareStatement("INSERT INTO " + SqliteLogsRepository.patterns(sourceId)
                         + " (id, template) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET template = excluded.template")) {
                // Ingest is the only writer of a source's lines (one lock per source), so row ids can be
                // assigned here and every statement batched - no round trip per row for the new rowid.
                // A resumed batch can overlap the last committed one; those lines are skipped up front.
                Set<String> existing = existingIds(c, ll, batch);
                long rid = nextRid(c, ll);
                GroupTotals groups = new GroupTotals();
                for (LineRecord r : batch.lines()) {
                    if (existing.contains(r.lineId())) {
                        continue;
                    }
                    int i = 1;
                    ins.setLong(i++, rid);
                    ins.setString(i++, r.lineId());
                    ins.setString(i++, r.inputId());
                    ins.setLong(i++, r.byteOffset());
                    ins.setLong(i++, r.ts());
                    ins.setLong(i++, now);
                    ins.setString(i++, r.level());
                    ins.setInt(i++, r.groupLevel());
                    ins.setString(i++, r.groupPath());
                    ins.setString(i++, r.missingLevel());
                    ins.setLong(i++, r.patternId());
                    ins.setObject(i++, r.duration() == 0 ? null : r.duration());
                    ins.setInt(i++, r.unparsed() ? 1 : 0);
                    ins.setObject(i++, r.unparsed() ? null : r.shape());
                    ins.setInt(i++, r.bytes());
                    ins.setString(i++, r.raw());
                    for (FieldDef f : stored) {
                        ins.setString(i++, r.text().get(f.index()));
                    }
                    for (FieldDef f : typed) {
                        ins.setObject(i++, r.typed().get(f.index()));
                    }
                    ins.addBatch();
                    if (r.ftsText() != null && !r.ftsText().isEmpty()) {
                        fts.setLong(1, rid);
                        fts.setString(2, r.ftsText());
                        fts.addBatch();
                    }
                    groups.add(r.groupPath(), r.ts(), "ERROR".equals(r.level()), r.duration());
                    rid++;
                    inserted++;
                    bytes += r.bytes();
                    if (r.unparsed()) {
                        unparsed++;
                    }
                }
                ins.executeBatch();
                fts.executeBatch();
                groups.flush(c, SqliteLogsRepository.groups(sourceId));
                for (Pattern p : batch.patternUpserts()) {
                    pat.setLong(1, p.id());
                    pat.setString(2, p.template());
                    pat.addBatch();
                }
                pat.executeBatch();
                upsertShapes(c, sourceId, batch.shapeUpserts());
                try (PreparedStatement in = c.prepareStatement("UPDATE log_input SET position = ?, lines_read = lines_read + ?, "
                        + "unparsed_count = unparsed_count + ?, updated_at = ? WHERE id = ?")) {
                    in.setLong(1, batch.inputPosition());
                    in.setLong(2, batch.inputLines());
                    in.setLong(3, batch.unparsed());
                    in.setString(4, Instant.now().toString());
                    in.setString(5, batch.inputId());
                    in.executeUpdate();
                }
                try (PreparedStatement src = c.prepareStatement("UPDATE log_source SET line_count = line_count + ?, "
                        + "stored_bytes = stored_bytes + ?, unparsed_count = unparsed_count + ? WHERE id = ?")) {
                    src.setLong(1, inserted);
                    src.setLong(2, bytes);
                    src.setLong(3, unparsed);
                    src.setString(4, sourceId);
                    src.executeUpdate();
                }
                c.commit();
            } catch (SQLException | RuntimeException e) {
                c.rollback();
                throw e;
            } finally {
                c.setAutoCommit(true);
                if (!batch.shapeUpserts().isEmpty()) {
                    shapeCache.remove(sourceId);
                }
            }
        } catch (SQLException e) {
            throw new IllegalStateException("Could not store log lines for source " + sourceId, e);
        }
        return inserted;
    }

    private static Set<String> existingIds(Connection c, String ll, Batch batch) throws SQLException {
        Set<String> out = new HashSet<>();
        if (batch.lines().isEmpty()) {
            return out;
        }
        long lo = Long.MAX_VALUE;
        long hi = Long.MIN_VALUE;
        for (LineRecord r : batch.lines()) {
            lo = Math.min(lo, r.byteOffset());
            hi = Math.max(hi, r.byteOffset());
        }
        try (PreparedStatement q = c.prepareStatement("SELECT line_id FROM " + ll + " WHERE input_id = ? AND byte_offset BETWEEN ? AND ?")) {
            q.setString(1, batch.inputId());
            q.setLong(2, lo);
            q.setLong(3, hi);
            try (ResultSet rs = q.executeQuery()) {
                while (rs.next()) {
                    out.add(rs.getString(1));
                }
            }
        }
        return out;
    }

    private static long nextRid(Connection c, String ll) throws SQLException {
        try (PreparedStatement q = c.prepareStatement("SELECT coalesce(max(rid), 0) + 1 FROM " + ll); ResultSet rs = q.executeQuery()) {
            rs.next();
            return rs.getLong(1);
        }
    }

    /**
     * Group-node aggregates summed in memory first, so a batch writes one upsert per distinct node
     * instead of one per line per ancestor (a session with hundreds of lines is one row update).
     */
    static final class GroupTotals {

        private static final class Agg {
            long first = Long.MAX_VALUE;
            long last = Long.MIN_VALUE;
            long lines;
            long errors;
            double maxDuration;
        }

        private final Map<String, Agg> nodes = new HashMap<>();

        void add(String path, long ts, boolean error, double duration) {
            if (path == null || path.isEmpty()) {
                return;
            }
            for (String p : GroupKeyer.ancestorsAndSelf(path)) {
                Agg a = nodes.computeIfAbsent(p, k -> new Agg());
                a.first = Math.min(a.first, ts);
                a.last = Math.max(a.last, ts);
                a.lines++;
                a.errors += error ? 1 : 0;
                a.maxDuration = Math.max(a.maxDuration, duration);
            }
        }

        int size() {
            return nodes.size();
        }

        void flush(Connection c, String table) throws SQLException {
            if (nodes.isEmpty()) {
                return;
            }
            try (PreparedStatement up = c.prepareStatement("INSERT INTO " + table
                    + " (path, parent_path, level, id, first_ts, last_ts, line_count, error_count, max_duration) VALUES (?,?,?,?,?,?,?,?,?) "
                    + "ON CONFLICT(path) DO UPDATE SET first_ts = min(first_ts, excluded.first_ts), last_ts = max(last_ts, excluded.last_ts), "
                    + "line_count = line_count + excluded.line_count, error_count = error_count + excluded.error_count, "
                    + "max_duration = max(coalesce(max_duration, 0), coalesce(excluded.max_duration, 0))")) {
                for (var e : nodes.entrySet()) {
                    String p = e.getKey();
                    Agg a = e.getValue();
                    int cut = p.lastIndexOf(GroupKeyer.SEP);
                    up.setString(1, p);
                    up.setString(2, cut < 0 ? "" : p.substring(0, cut));
                    up.setInt(3, GroupKeyer.ancestorsAndSelf(p).size());
                    up.setString(4, cut < 0 ? p : p.substring(cut + 1));
                    up.setLong(5, a.first);
                    up.setLong(6, a.last);
                    up.setLong(7, a.lines);
                    up.setLong(8, a.errors);
                    up.setObject(9, a.maxDuration == 0 ? null : a.maxDuration);
                    up.addBatch();
                }
                up.executeBatch();
            }
            nodes.clear();
        }
    }

    // ------------------------------------------------------------------ reads

    private String summaryCols(String sourceId, List<FieldDef> fields) {
        Set<String> have = columnsOf(sourceId);
        StringBuilder sb = new StringBuilder(BASE_COLS);
        for (FieldDef f : fields) {
            if (!f.stored()) {
                continue;
            }
            if (have.contains(SqliteLogQueryTranslator.text(f))) {
                sb.append(", ").append(SqliteLogQueryTranslator.text(f));
            }
            if (f.typed() && have.contains(SqliteLogQueryTranslator.typedCol(f))) {
                sb.append(", ").append(SqliteLogQueryTranslator.typedCol(f));
            }
        }
        return sb.toString();
    }

    private LogLineSummary summary(ResultSet rs, List<FieldDef> fields) throws SQLException {
        Map<String, Object> values = new LinkedHashMap<>();
        Set<String> present = present(rs);
        for (FieldDef f : fields) {
            Object v = value(rs, f, present);
            if (v != null) {
                values.put(f.label(), v);
            }
        }
        return new LogLineSummary(rs.getString("line_id"), rs.getLong("ts_ms"), rs.getString("level"),
                rs.getInt("group_level"), rs.getString("group_path"), rs.getString("missing_level"),
                rs.getInt("pinned") == 1, rs.getInt("unparsed") == 1, rs.getInt("shape"), values, 0);
    }

    private static Set<String> present(ResultSet rs) throws SQLException {
        Set<String> out = new HashSet<>();
        for (int i = 1; i <= rs.getMetaData().getColumnCount(); i++) {
            out.add(rs.getMetaData().getColumnName(i));
        }
        return out;
    }

    /** Numbers and booleans come back typed; dates and text come back as the original text. */
    private static Object value(ResultSet rs, FieldDef f, Set<String> present) throws SQLException {
        String tc = SqliteLogQueryTranslator.typedCol(f);
        if (f.typed() && present.contains(tc)) {
            Object t = rs.getObject(tc);
            if (t instanceof Number num) {
                if (f.type() == FieldType.NUMBER) {
                    double d = num.doubleValue();
                    return d == Math.rint(d) && Math.abs(d) < 9e15 ? (Object) (long) d : (Object) d;
                }
                if (f.type() == FieldType.BOOLEAN) {
                    return num.intValue() == 1;
                }
            }
        }
        String fc = SqliteLogQueryTranslator.text(f);
        return present.contains(fc) ? rs.getString(fc) : null;
    }

    /**
     * The column a field sort orders by, or null for time order. A field's typed shadow column when it
     * has one (numbers sort as numbers, datetimes as instants), else its text; the level role's first
     * field sorts by the line's level, like its filters.
     */
    private String sortCol(LogStructure s, LogQuery q) {
        if (q.sort() == null || q.sort().field() == null || q.sort().field().isBlank()) {
            return null;
        }
        FieldDef f = s.byLabel(q.sort().field()).filter(FieldDef::stored)
                .orElseThrow(() -> new IllegalArgumentException("Unknown field to sort by: " + q.sort().field()));
        return SqliteLogQueryTranslator.filterCol(s, f, true);
    }

    /** Time order, or a field's order with lines lacking the field last (time breaks ties). */
    private String order(LogStructure s, LogQuery q) {
        String dir = q.sort() != null && q.sort().ascending() ? "ASC" : "DESC";
        String col = sortCol(s, q);
        return col == null ? "ts_ms " + dir + ", rid " + dir : "(" + col + " IS NULL) ASC, " + col + " " + dir + ", ts_ms " + dir + ", rid " + dir;
    }

    @Override
    public LogPage query(String sourceId, LogStructure structure, LogQuery query, List<FieldDef> summaryFields) {
        return page(sourceId, structure, query, summaryFields, null, List.of());
    }

    @Override
    public LogPage bucket(String sourceId, LogStructure structure, LogQuery query, List<FieldDef> summaryFields) {
        return page(sourceId, structure, query, summaryFields, "group_level = 0", List.of());
    }

    @Override
    public LogPage nodeLines(String sourceId, LogStructure structure, LogQuery query, String path, int level, boolean skipped,
                             List<FieldDef> summaryFields) {
        LogQuery inOrder = new LogQuery(query.pills(), query.from(), query.to(), new LogQuery.Sort(null, true), query.cursor(), query.limit());
        return skipped
                ? page(sourceId, structure, inOrder, summaryFields, "group_path = ? AND missing_level IS NOT NULL", List.of(path))
                : page(sourceId, structure, inOrder, summaryFields, "group_path = ? AND group_level = ? AND missing_level IS NULL",
                List.of(path, level));
    }

    @Override
    public List<LogLineSummary> invalidValues(String sourceId, FieldDef field, int limit, List<FieldDef> summaryFields) {
        Set<String> have = columnsOf(sourceId);
        String t = SqliteLogQueryTranslator.typedCol(field);
        String f = SqliteLogQueryTranslator.text(field);
        if (!have.contains(t) || !have.contains(f)) {
            return List.of();
        }
        List<FieldDef> fields = new ArrayList<>(summaryFields);
        if (!fields.contains(field)) {
            fields.add(field);
        }
        return jdbc().query("SELECT " + summaryCols(sourceId, fields) + " FROM " + SqliteLogsRepository.lines(sourceId)
                + " WHERE " + f + " IS NOT NULL AND " + t + " IS NULL ORDER BY ts_ms DESC, rid DESC LIMIT ?",
                (rs, i) -> summary(rs, fields), limit);
    }

    private LogPage page(String sourceId, LogStructure s, LogQuery q, List<FieldDef> fields, String extra, List<Object> extraParams) {
        long started = System.currentTimeMillis();
        String ll = SqliteLogsRepository.lines(sourceId);
        Sql w = SqliteLogQueryTranslator.where(sourceId, s, q);
        String where = w.where() + (extra == null ? "" : " AND " + extra);
        List<Object> params = new ArrayList<>(w.params());
        params.addAll(extraParams);
        boolean asc = q.sort() != null && q.sort().ascending();
        String sc = sortCol(s, q);
        String cmp = asc ? ">" : "<";
        String keyset = "";
        List<Object> keyParams = new ArrayList<>();
        if (q.cursor() != null && !q.cursor().isBlank()) {
            if (sc == null) {
                String[] c = q.cursor().split(":");
                long ts = Long.parseLong(c[0]);
                long rid = Long.parseLong(c[1]);
                keyset = " AND (ts_ms " + cmp + " ? OR (ts_ms = ? AND rid " + cmp + " ?))";
                keyParams.addAll(List.of(ts, ts, rid));
            } else {
                FieldCursor fc = FieldCursor.parse(q.cursor());
                String tie = "(ts_ms " + cmp + " ? OR (ts_ms = ? AND rid " + cmp + " ?))";
                if (fc.value() == null) {
                    keyset = " AND (" + sc + " IS NULL AND " + tie + ")";
                    keyParams.addAll(List.of(fc.ts(), fc.ts(), fc.rid()));
                } else {
                    keyset = " AND ((" + sc + " IS NOT NULL AND (" + sc + " " + cmp + " ? OR (" + sc + " = ? AND " + tie + "))) OR "
                            + sc + " IS NULL)";
                    keyParams.addAll(List.of(fc.value(), fc.value(), fc.ts(), fc.ts(), fc.rid()));
                }
            }
        }
        List<Object> all = new ArrayList<>(params);
        all.addAll(keyParams);
        all.add(q.limit() + 1);
        List<Object[]> rows = new ArrayList<>();
        List<LogLineSummary> lines = jdbc().query("SELECT " + summaryCols(sourceId, fields) + (sc == null ? "" : ", " + sc + " AS sort_v")
                        + " FROM " + ll + " WHERE " + where + keyset + " ORDER BY " + order(s, q) + " LIMIT ?",
                (rs, i) -> {
                    rows.add(new Object[]{rs.getLong("ts_ms"), rs.getLong("rid"), sc == null ? null : rs.getObject("sort_v")});
                    return summary(rs, fields);
                }, all.toArray());
        String next = null;
        if (lines.size() > q.limit()) {
            lines = new ArrayList<>(lines.subList(0, q.limit()));
            Object[] last = rows.get(q.limit() - 1);
            next = sc == null ? last[0] + ":" + last[1] : new FieldCursor(last[2], (Long) last[0], (Long) last[1]).encode();
        }
        long total = -1;
        if (q.cursor() == null || q.cursor().isBlank()) {
            // Unfiltered: the source's line counter (kept in the batch transaction) - no scan of every line.
            Long t = "1=1".equals(where)
                    ? jdbc().queryForObject("SELECT line_count FROM log_source WHERE id = ?", Long.class, sourceId)
                    : jdbc().queryForObject("SELECT count(*) FROM " + ll + " WHERE " + where, Long.class, params.toArray());
            total = t == null ? 0 : t;
        }
        return new LogPage(lines, total, next, System.currentTimeMillis() - started, w.slow());
    }

    @Override
    public Optional<LogLine> get(String sourceId, LogStructure structure, String lineId) {
        List<FieldDef> stored = structure.fields().stream().filter(FieldDef::stored).toList();
        List<LogLine> found = jdbc().query("SELECT " + summaryCols(sourceId, stored) + ", raw FROM "
                + SqliteLogsRepository.lines(sourceId) + " WHERE line_id = ?", (rs, i) -> {
            LogLineSummary sm = summary(rs, stored);
            return new LogLine(sm.lineId(), rs.getString("input_id"), rs.getLong("byte_offset"), sm.ts(), sm.level(),
                    sm.groupLevel(), sm.groupPath(), sm.missingLevel(), sm.pinned(), sm.unparsed(), sm.shape(),
                    sm.fields(), rs.getString("raw"), null);
        }, lineId);
        return found.stream().findFirst();
    }

    @Override
    public List<LogLineSummary> context(String sourceId, LogStructure structure, String lineId, int before, int after,
                                        List<FieldDef> fields) {
        String ll = SqliteLogsRepository.lines(sourceId);
        List<Map<String, Object>> at = jdbc().queryForList("SELECT input_id, byte_offset FROM " + ll + " WHERE line_id = ?", lineId);
        if (at.isEmpty()) {
            return List.of();
        }
        String input = (String) at.get(0).get("input_id");
        long offset = ((Number) at.get(0).get("byte_offset")).longValue();
        String cols = summaryCols(sourceId, fields);
        List<LogLineSummary> earlier = jdbc().query("SELECT " + cols + " FROM " + ll
                + " WHERE input_id = ? AND byte_offset < ? ORDER BY byte_offset DESC LIMIT ?", (rs, i) -> summary(rs, fields), input, offset, before);
        List<LogLineSummary> out = new ArrayList<>(earlier);
        Collections.reverse(out);
        out.addAll(jdbc().query("SELECT " + cols + " FROM " + ll
                + " WHERE input_id = ? AND byte_offset >= ? ORDER BY byte_offset ASC LIMIT ?", (rs, i) -> summary(rs, fields), input, offset, after + 1));
        return out;
    }

    @Override
    public Histogram histogram(String sourceId, LogStructure structure, LogQuery query, int buckets) {
        String ll = SqliteLogsRepository.lines(sourceId);
        Sql w = SqliteLogQueryTranslator.where(sourceId, structure, query);
        Map<String, Object> range = jdbc().queryForMap("SELECT min(ts_ms) lo, max(ts_ms) hi FROM " + ll + " WHERE " + w.where(), w.params().toArray());
        if (range.get("lo") == null) {
            return new Histogram(0, 0, 0, List.of());
        }
        long lo = ((Number) range.get("lo")).longValue();
        long hi = ((Number) range.get("hi")).longValue();
        long width = Math.max(1, (hi - lo) / buckets + 1);
        List<Object> p = new ArrayList<>();
        p.add(lo);
        p.add(width);
        p.addAll(w.params());
        Map<Long, Map<String, Long>> byBucket = new java.util.TreeMap<>();
        jdbc().query("SELECT (ts_ms - ?) / ? b, coalesce(level, '') lv, count(*) c FROM " + ll + " WHERE " + w.where() + " GROUP BY b, lv",
                rs -> {
                    byBucket.computeIfAbsent(rs.getLong("b"), k -> new LinkedHashMap<>()).put(rs.getString("lv"), rs.getLong("c"));
                }, p.toArray());
        List<Histogram.Bucket> out = new ArrayList<>();
        for (int b = 0; b < buckets; b++) {
            out.add(new Histogram.Bucket(lo + b * width, byBucket.getOrDefault((long) b, Map.of())));
        }
        return new Histogram(lo, hi, width, out);
    }

    /** The latest {@code window} matching rows, newest first: the bounded sample sidebar counts and stats use. */
    private List<Map<Integer, Object>> window(String sourceId, LogStructure s, LogQuery q, List<FieldDef> fields, int window) {
        Sql w = SqliteLogQueryTranslator.where(sourceId, s, q);
        List<Object> p = new ArrayList<>(w.params());
        p.add(window);
        List<FieldDef> stored = fields.stream().filter(FieldDef::stored).toList();
        return jdbc().query("SELECT " + summaryCols(sourceId, stored) + " FROM " + SqliteLogsRepository.lines(sourceId)
                + " WHERE " + w.where() + " ORDER BY ts_ms DESC, rid DESC LIMIT ?", (rs, i) -> {
            Set<String> present = present(rs);
            Map<Integer, Object> m = new HashMap<>();
            for (FieldDef f : stored) {
                Object v = value(rs, f, present);
                if (v != null) {
                    m.put(f.index(), v);
                }
            }
            return m;
        }, p.toArray());
    }

    /** Distinct values tracked per field for the sidebar's top values; later new values are not tracked. */
    static final int MAX_TRACKED_VALUES = 200;
    /** Longer values (payloads, stack traces) count as present but are never top-value candidates. */
    static final int MAX_TRACKED_LENGTH = 200;
    /**
     * Rows × fields read for the sidebar at most: a source with hundreds of fields samples fewer of the
     * latest lines (900 fields → ~550 lines) instead of reading millions of cells. The response says
     * how many lines were sampled.
     */
    static final long MAX_SIDEBAR_CELLS = 500_000;

    /**
     * Counted while the rows stream past - never held: with hundreds of fields (lines of many
     * structures, big payloads) a 10,000-row window kept in memory ran the backend out of heap.
     * Only the original-text columns are read; memory is bounded by fields × MAX_TRACKED_VALUES.
     */
    @Override
    public FieldValues fieldValues(String sourceId, LogStructure structure, LogQuery query, List<FieldDef> fields, int window, int top) {
        Set<String> have = columnsOf(sourceId);
        List<FieldDef> cols = fields.stream().filter(f -> f.stored() && have.contains(SqliteLogQueryTranslator.text(f))).toList();
        Sql w = SqliteLogQueryTranslator.where(sourceId, structure, query);
        List<Object> p = new ArrayList<>(w.params());
        int rowsToRead = (int) Math.max(100, Math.min(window, MAX_SIDEBAR_CELLS / Math.max(1, cols.size())));
        p.add(rowsToRead);
        long[] present = new long[cols.size()];
        List<Map<String, Long>> counts = new ArrayList<>();
        cols.forEach(f -> counts.add(new HashMap<>()));
        long[] rows = {0};
        // The level field counts the line's level - what its filter matches (SqliteLogQueryTranslator.isLevelField).
        String select = cols.isEmpty() ? "rid" : cols.stream().map(f -> SqliteLogQueryTranslator.filterCol(structure, f, false))
                .collect(Collectors.joining(", "));
        jdbc().query("SELECT " + select + " FROM " + SqliteLogsRepository.lines(sourceId) + " WHERE " + w.where()
                + " ORDER BY ts_ms DESC, rid DESC LIMIT ?", rs -> {
            rows[0]++;
            for (int k = 0; k < cols.size(); k++) {
                String v = rs.getString(k + 1);
                if (v == null) {
                    continue;
                }
                present[k]++;
                if (cols.get(k).searchMode() == SearchMode.TEXT || v.length() > MAX_TRACKED_LENGTH) {
                    continue;
                }
                Map<String, Long> c = counts.get(k);
                Long n = c.get(v);
                if (n != null) {
                    c.put(v, n + 1);
                } else if (c.size() < MAX_TRACKED_VALUES) {
                    c.put(v, 1L);
                }
            }
        }, p.toArray());
        Map<String, FieldValues.Field> out = new LinkedHashMap<>();
        for (int k = 0; k < cols.size(); k++) {
            List<FieldValues.ValueCount> best = counts.get(k).entrySet().stream()
                    .sorted(Map.Entry.<String, Long>comparingByValue().reversed()).limit(top)
                    .map(e -> new FieldValues.ValueCount(e.getKey(), e.getValue())).toList();
            out.put(cols.get(k).label(), new FieldValues.Field(rows[0] == 0 ? 0 : present[k] / (double) rows[0], best));
        }
        return new FieldValues(rowsToRead, (int) rows[0], out);
    }

    @Override
    public FieldStats fieldStats(String sourceId, LogStructure structure, LogQuery query, FieldDef f, int window) {
        List<Map<Integer, Object>> rows = window(sourceId, structure, query, List.of(f), window);
        if (f.type() == FieldType.STRING || f.type() == FieldType.BOOLEAN) {
            Map<String, Long> counts = new HashMap<>();
            rows.forEach(r -> {
                Object v = r.get(f.index());
                if (v != null) {
                    counts.merge(String.valueOf(v), 1L, Long::sum);
                }
            });
            List<FieldValues.ValueCount> best = counts.entrySet().stream().sorted(Map.Entry.<String, Long>comparingByValue().reversed())
                    .limit(10).map(e -> new FieldValues.ValueCount(e.getKey(), e.getValue())).toList();
            long n = counts.values().stream().mapToLong(Long::longValue).sum();
            return new FieldStats(f.label(), f.type().name(), n, false, window, null, null, null, null, null, List.of(),
                    (long) counts.size(), best);
        }
        // Numbers and dates: distribution from the window; percentiles exact when the field is indexed.
        double[] sample = rows.stream().map(r -> r.get(f.index())).filter(v -> v != null)
                .mapToDouble(v -> v instanceof Number n ? n.doubleValue() : typedMillis(f, v)).filter(d -> !Double.isNaN(d)).sorted().toArray();
        boolean exact = f.searchMode() == SearchMode.EXACT && columnsOf(sourceId).contains(SqliteLogQueryTranslator.typedCol(f));
        Double p50;
        Double p95;
        Double p99;
        Double min;
        Double max;
        long n;
        if (exact) {
            String ll = SqliteLogsRepository.lines(sourceId);
            String col = SqliteLogQueryTranslator.typedCol(f);
            Sql w = SqliteLogQueryTranslator.where(sourceId, structure, query);
            String where = w.where() + " AND " + col + " IS NOT NULL";
            Map<String, Object> agg = jdbc().queryForMap("SELECT count(*) n, min(" + col + ") lo, max(" + col + ") hi FROM " + ll + " WHERE " + where,
                    w.params().toArray());
            n = ((Number) agg.get("n")).longValue();
            min = agg.get("lo") == null ? null : ((Number) agg.get("lo")).doubleValue();
            max = agg.get("hi") == null ? null : ((Number) agg.get("hi")).doubleValue();
            p50 = percentile(ll, col, where, w.params(), n, 0.5);
            p95 = percentile(ll, col, where, w.params(), n, 0.95);
            p99 = percentile(ll, col, where, w.params(), n, 0.99);
        } else {
            n = sample.length;
            min = n == 0 ? null : sample[0];
            max = n == 0 ? null : sample[sample.length - 1];
            p50 = pick(sample, 0.5);
            p95 = pick(sample, 0.95);
            p99 = pick(sample, 0.99);
        }
        List<Long> dist = new ArrayList<>(Collections.nCopies(24, 0L));
        if (sample.length > 0) {
            double lo = sample[0];
            double width = (sample[sample.length - 1] - lo) / 24;
            for (double d : sample) {
                int b = width == 0 ? 0 : (int) Math.min(23, (d - lo) / width);
                dist.set(b, dist.get(b) + 1);
            }
        }
        return new FieldStats(f.label(), f.type().name(), n, exact, window, min, max, p50, p95, p99, dist, null, List.of());
    }

    private Double percentile(String ll, String col, String where, List<Object> params, long n, double p) {
        if (n == 0) {
            return null;
        }
        List<Object> all = new ArrayList<>(params);
        all.add((long) Math.min(n - 1, Math.floor(p * n)));
        List<Double> v = jdbc().query("SELECT " + col + " FROM " + ll + " WHERE " + where + " ORDER BY " + col + " LIMIT 1 OFFSET ?",
                (rs, i) -> rs.getDouble(1), all.toArray());
        return v.isEmpty() ? null : v.get(0);
    }

    private static Double pick(double[] sorted, double p) {
        return sorted.length == 0 ? null : sorted[(int) Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    }

    private static double typedMillis(FieldDef f, Object v) {
        return com.fathy.alfred.backend.logs.domain.ingest.ValueTyper.convert(v, f.type(), f.format())
                .map(o -> ((Number) o).doubleValue()).orElse(Double.NaN);
    }

    @Override
    public Minimap minimap(String sourceId, LogStructure structure, LogQuery query, List<LogQuery.Pill> condition, int buckets, long sampleAbove) {
        String ll = SqliteLogsRepository.lines(sourceId);
        Sql w = SqliteLogQueryTranslator.where(sourceId, structure, query);
        Long totalBox = jdbc().queryForObject("SELECT count(*) FROM " + ll + " WHERE " + w.where(), Long.class, w.params().toArray());
        long total = totalBox == null ? 0 : totalBox;
        boolean sampled = total > sampleAbove;
        String where = w.where() + (sampled ? " AND rid % " + (total / sampleAbove + 1) + " = 0" : "");
        String cond;
        List<Object> params = new ArrayList<>();
        if (condition == null || condition.isEmpty()) {
            cond = "level IN ('ERROR','WARN')";
        } else {
            Sql c = SqliteLogQueryTranslator.condition(sourceId, structure, condition);
            cond = c.where();
            params.addAll(c.params());
        }
        params.add(buckets);
        params.addAll(w.params());
        List<Long> matches = new ArrayList<>(Collections.nCopies(buckets, 0L));
        List<Long> errors = new ArrayList<>(Collections.nCopies(buckets, 0L));
        List<Long> warns = new ArrayList<>(Collections.nCopies(buckets, 0L));
        jdbc().query("SELECT b, sum(m) m, sum(level = 'ERROR') e, sum(level = 'WARN') wn FROM ("
                + "SELECT CASE WHEN " + cond + " THEN 1 ELSE 0 END m, level, ntile(?) OVER (ORDER BY " + order(structure, query) + ") b FROM "
                + ll + " WHERE " + where + ") GROUP BY b", rs -> {
            int b = rs.getInt("b") - 1;
            if (b >= 0 && b < buckets) {
                matches.set(b, rs.getLong("m"));
                errors.set(b, rs.getLong("e"));
                warns.set(b, rs.getLong("wn"));
            }
        }, params.toArray());
        return new Minimap(total, sampled, matches, errors, warns);
    }

    @Override
    public List<LogLineSummary> trace(String sourceId, LogStructure structure, List<FieldDef> correlation, String value, int limit,
                                      List<FieldDef> fields) {
        Set<String> have = columnsOf(sourceId);
        List<String> cols = correlation.stream().map(SqliteLogQueryTranslator::text).filter(have::contains).toList();
        if (cols.isEmpty()) {
            return List.of();
        }
        List<Object> p = new ArrayList<>();
        cols.forEach(c -> p.add(value));
        p.add(limit);
        return jdbc().query("SELECT " + summaryCols(sourceId, fields) + " FROM " + SqliteLogsRepository.lines(sourceId)
                        + " WHERE " + cols.stream().map(c -> c + " = ?").collect(Collectors.joining(" OR "))
                        + " ORDER BY ts_ms ASC, rid ASC LIMIT ?",
                (rs, i) -> summary(rs, fields), p.toArray());
    }

    // ------------------------------------------------------------------ groups

    private static String nodeOrder(GroupSort sort) {
        return switch (sort == null ? GroupSort.TIME_ASC : sort) {
            case TIME_ASC -> "first_ts ASC, id ASC";
            case TIME_DESC -> "first_ts DESC, id ASC";
            case ERRORS_DESC -> "error_count DESC, first_ts ASC";
            case LINES_DESC -> "line_count DESC, first_ts ASC";
            case MAX_DURATION_DESC -> "coalesce(max_duration, 0) DESC, first_ts ASC";
            case ID_ASC -> "id ASC";
        };
    }

    @Override
    public List<GroupNode> groups(String sourceId, LogStructure s, LogQuery query, String parentPath, int level,
                                  int offset, int limit, List<FieldDef> fields) {
        GroupSort sort = level >= 1 && level <= s.groupLevels().size() ? s.groupLevels().get(level - 1).sort() : GroupSort.TIME_ASC;
        String ll = SqliteLogsRepository.lines(sourceId);
        Sql w = SqliteLogQueryTranslator.where(sourceId, s, query);
        boolean filtered = query.hasFilters();
        List<Object[]> nodes = new ArrayList<>(); // path, id, first, last, lines, errors, maxDur, hasChildren
        if (!filtered) {
            String lg = SqliteLogsRepository.groups(sourceId);
            jdbc().query("SELECT g.*, EXISTS(SELECT 1 FROM " + lg + " c WHERE c.parent_path = g.path) has_kids FROM " + lg
                    + " g WHERE parent_path = ? ORDER BY " + nodeOrder(sort) + " LIMIT ? OFFSET ?", rs -> {
                nodes.add(new Object[]{rs.getString("path"), rs.getString("id"), rs.getLong("first_ts"), rs.getLong("last_ts"),
                        rs.getLong("line_count"), rs.getLong("error_count"), rs.getDouble("max_duration"), rs.getInt("has_kids") == 1});
            }, parentPath, limit, offset);
        } else {
            String prefixCond;
            String childExpr;
            List<Object> p = new ArrayList<>();
            if (parentPath.isEmpty()) {
                prefixCond = "group_level >= 1";
                childExpr = "CASE WHEN instr(group_path, char(1)) > 0 THEN substr(group_path, 1, instr(group_path, char(1)) - 1) ELSE group_path END";
            } else {
                prefixCond = "group_path > ? AND group_path < ?";
                p.add(parentPath + GroupKeyer.SEP);
                p.add(parentPath + (char) (GroupKeyer.SEP + 1));
                String rest = "substr(group_path, " + (parentPath.length() + 2) + ")";
                childExpr = "CASE WHEN instr(" + rest + ", char(1)) > 0 THEN substr(" + rest + ", 1, instr(" + rest + ", char(1)) - 1) ELSE " + rest + " END";
            }
            List<Object> all = new ArrayList<>(w.params());
            all.addAll(p);
            all.add(limit);
            all.add(offset);
            String prefix = parentPath.isEmpty() ? "" : parentPath + GroupKeyer.SEP;
            jdbc().query("SELECT child id, min(ts_ms) first_ts, max(ts_ms) last_ts, count(*) line_count, sum(level = 'ERROR') error_count, "
                    + "max(coalesce(duration, 0)) max_duration FROM (SELECT " + childExpr + " child, ts_ms, level, duration FROM " + ll
                    + " WHERE " + w.where() + " AND " + prefixCond + ") GROUP BY child ORDER BY " + nodeOrder(sort) + " LIMIT ? OFFSET ?", rs -> {
                nodes.add(new Object[]{prefix + rs.getString("id"), rs.getString("id"), rs.getLong("first_ts"), rs.getLong("last_ts"),
                        rs.getLong("line_count"), rs.getLong("error_count"), rs.getDouble("max_duration"), null});
            }, all.toArray());
        }
        String cols = summaryCols(sourceId, fields);
        List<GroupNode> out = new ArrayList<>();
        int nodeLevel = parentPath.isEmpty() ? 1 : parentPath.split(String.valueOf(GroupKeyer.SEP), -1).length + 1;
        for (Object[] n : nodes) {
            String path = (String) n[0];
            List<Object> own = new ArrayList<>();
            own.add(path);
            own.add(nodeLevel);
            own.addAll(w.params());
            own.add(NODE_LINES + 1);
            List<LogLineSummary> lines = jdbc().query("SELECT " + cols + " FROM " + ll + " WHERE group_path = ? AND group_level = ? "
                    + "AND missing_level IS NULL AND " + w.where() + " ORDER BY ts_ms ASC, rid ASC LIMIT ?", (rs, i) -> summary(rs, fields), own.toArray());
            List<Object> sk = new ArrayList<>();
            sk.add(path);
            sk.addAll(w.params());
            sk.add(NODE_LINES);
            List<LogLineSummary> skipped = jdbc().query("SELECT " + cols + " FROM " + ll + " WHERE group_path = ? AND missing_level IS NOT NULL AND "
                    + w.where() + " ORDER BY ts_ms ASC, rid ASC LIMIT ?", (rs, i) -> summary(rs, fields), sk.toArray());
            boolean hasKids;
            if (n[7] != null) {
                hasKids = (Boolean) n[7];
            } else {
                List<Object> kp = new ArrayList<>(w.params());
                kp.add(path + GroupKeyer.SEP);
                kp.add(path + (char) (GroupKeyer.SEP + 1));
                hasKids = !jdbc().queryForList("SELECT 1 FROM " + ll + " WHERE " + w.where() + " AND group_path > ? AND group_path < ? LIMIT 1",
                        kp.toArray()).isEmpty();
            }
            LogLineSummary head = lines.isEmpty() ? null : lines.get(0);
            List<LogLineSummary> siblings = lines.size() <= 1 ? List.of() : lines.subList(1, Math.min(lines.size(), NODE_LINES));
            long lineCount = (Long) n[4];
            out.add(new GroupNode(path, nodeLevel, (String) n[1], head, siblings, skipped, hasKids ? 1 : 0,
                    Math.max(0, lineCount - lines.size()), (Long) n[2], (Long) n[3], (Long) n[5], (Double) n[6]));
        }
        return out;
    }

    @Override
    public void rebuildGroups(String sourceId) {
        String lg = SqliteLogsRepository.groups(sourceId);
        String ll = SqliteLogsRepository.lines(sourceId);
        try (Connection c = repository.dataSource().getConnection()) {
            c.setAutoCommit(false);
            try (PreparedStatement del = c.prepareStatement("DELETE FROM " + lg);
                 PreparedStatement sel = c.prepareStatement("SELECT group_path, ts_ms, level, duration FROM " + ll + " WHERE group_level >= 1")) {
                del.executeUpdate();
                GroupTotals totals = new GroupTotals();
                try (ResultSet rs = sel.executeQuery()) {
                    while (rs.next()) {
                        totals.add(rs.getString(1), rs.getLong(2), "ERROR".equals(rs.getString(3)), rs.getDouble(4));
                        if (totals.size() >= REBUILD_FLUSH_NODES) {
                            totals.flush(c, lg); // bounded memory: partial sums merge in the upsert
                        }
                    }
                }
                totals.flush(c, lg);
                c.commit();
            } catch (SQLException | RuntimeException e) {
                c.rollback();
                throw e;
            } finally {
                c.setAutoCommit(true);
            }
        } catch (SQLException e) {
            throw new IllegalStateException("Could not rebuild groups for " + sourceId, e);
        }
    }

    // ------------------------------------------------------------------ patterns

    @Override
    public List<Pattern> patterns(String sourceId, LogStructure structure, LogQuery query, int limit) {
        Sql w = SqliteLogQueryTranslator.where(sourceId, structure, query);
        List<Object> p = new ArrayList<>(w.params());
        p.add(limit);
        String ll = SqliteLogsRepository.lines(sourceId);
        return jdbc().query("SELECT l.pattern_id id, coalesce(p.template, '') template, count(*) n, "
                + "max(CASE l.level WHEN 'ERROR' THEN 3 WHEN 'WARN' THEN 2 ELSE 1 END) worst FROM " + ll + " l LEFT JOIN "
                + SqliteLogsRepository.patterns(sourceId) + " p ON p.id = l.pattern_id WHERE " + w.where()
                + " GROUP BY l.pattern_id ORDER BY n DESC LIMIT ?", (rs, i) -> new Pattern(rs.getLong("id"), rs.getString("template"),
                rs.getLong("n"), switch (rs.getInt("worst")) {
            case 3 -> "ERROR";
            case 2 -> "WARN";
            default -> "INFO";
        }), p.toArray());
    }

    @Override
    public List<Pattern> storedPatterns(String sourceId) {
        return jdbc().query("SELECT id, template FROM " + SqliteLogsRepository.patterns(sourceId),
                (rs, i) -> new Pattern(rs.getLong(1), rs.getString(2), 0, null));
    }

    @Override
    public void replacePatterns(String sourceId, List<Pattern> patterns) {
        String lp = SqliteLogsRepository.patterns(sourceId);
        jdbc().update("DELETE FROM " + lp);
        jdbc().batchUpdate("INSERT INTO " + lp + " (id, template) VALUES (?, ?)",
                patterns.stream().map(p -> new Object[]{p.id(), p.template()}).toList());
    }

    // ------------------------------------------------------------------ selection, retention, maintenance

    @Override
    public long pin(String sourceId, LogStructure structure, LogQuery selection) {
        Sql w = SqliteLogQueryTranslator.where(sourceId, structure, selection);
        return jdbc().update("UPDATE " + SqliteLogsRepository.lines(sourceId) + " SET pinned = 1 WHERE " + w.where(), w.params().toArray());
    }

    @Override
    public void pinOne(String sourceId, String lineId) {
        jdbc().update("UPDATE " + SqliteLogsRepository.lines(sourceId) + " SET pinned = 1 WHERE line_id = ?", lineId);
    }

    @Override
    public long countMatching(String sourceId, LogStructure structure, LogQuery query) {
        Sql w = SqliteLogQueryTranslator.where(sourceId, structure, query);
        Long n = jdbc().queryForObject("SELECT count(*) FROM " + SqliteLogsRepository.lines(sourceId) + " WHERE " + w.where(), Long.class,
                w.params().toArray());
        return n == null ? 0 : n;
    }

    @Override
    public long countErrors(String sourceId, LogStructure structure, LogQuery query) {
        Sql w = SqliteLogQueryTranslator.where(sourceId, structure, query);
        Long n = jdbc().queryForObject("SELECT count(*) FROM " + SqliteLogsRepository.lines(sourceId) + " WHERE " + w.where()
                + " AND level = 'ERROR'", Long.class, w.params().toArray());
        return n == null ? 0 : n;
    }

    @Override
    public List<String> matchingIds(String sourceId, LogStructure structure, LogQuery query, int max) {
        Sql w = SqliteLogQueryTranslator.where(sourceId, structure, query);
        List<Object> p = new ArrayList<>(w.params());
        p.add(max);
        return jdbc().queryForList("SELECT line_id FROM " + SqliteLogsRepository.lines(sourceId) + " WHERE " + w.where()
                + " ORDER BY " + order(structure, query) + " LIMIT ?", String.class, p.toArray());
    }

    @Override
    public long[] applyRetention(String sourceId, long currentBytes, long targetBytes) {
        String ll = SqliteLogsRepository.lines(sourceId);
        long lines = 0;
        long bytes = 0;
        long remaining = currentBytes;
        // Oldest first in chunks, so one retention pass never holds a huge delete in a single statement.
        while (remaining > targetBytes) {
            List<Map<String, Object>> chunk = jdbc().queryForList("SELECT rid, bytes FROM " + ll
                    + " WHERE pinned = 0 ORDER BY ts_ms ASC, rid ASC LIMIT 5000");
            if (chunk.isEmpty()) {
                break;
            }
            long maxRid = 0;
            long chunkBytes = 0;
            List<Long> rids = new ArrayList<>();
            for (Map<String, Object> r : chunk) {
                rids.add(((Number) r.get("rid")).longValue());
                chunkBytes += ((Number) r.get("bytes")).longValue();
                maxRid = Math.max(maxRid, rids.get(rids.size() - 1));
            }
            String in = rids.stream().map(String::valueOf).collect(Collectors.joining(","));
            jdbc().update("DELETE FROM " + SqliteLogsRepository.fts(sourceId) + " WHERE rowid IN (" + in + ")");
            lines += jdbc().update("DELETE FROM " + ll + " WHERE rid IN (" + in + ")");
            bytes += chunkBytes;
            remaining -= chunkBytes;
        }
        return new long[]{lines, bytes};
    }

    private long deleteWhere(String sourceId, String where, Object... params) {
        String ll = SqliteLogsRepository.lines(sourceId);
        jdbc().update("DELETE FROM " + SqliteLogsRepository.fts(sourceId) + " WHERE rowid IN (SELECT rid FROM " + ll + " WHERE " + where + ")", params);
        return jdbc().update("DELETE FROM " + ll + " WHERE " + where, params);
    }

    @Override
    public long[] counts(String sourceId) {
        Map<String, Object> m = jdbc().queryForMap("SELECT count(*) n, coalesce(sum(bytes), 0) b FROM " + SqliteLogsRepository.lines(sourceId));
        return new long[]{((Number) m.get("n")).longValue(), ((Number) m.get("b")).longValue()};
    }

    @Override
    public long pinnedCount(String sourceId) {
        Long n = jdbc().queryForObject("SELECT count(*) FROM " + SqliteLogsRepository.lines(sourceId) + " WHERE pinned = 1", Long.class);
        return n == null ? 0 : n;
    }

    @Override
    public long deleteInput(String sourceId, String inputId) {
        return deleteWhere(sourceId, "input_id = ? AND pinned = 0", inputId);
    }

    // ------------------------------------------------------------------ structures of lines

    private static String join(List<Integer> ints) {
        return ints.stream().map(String::valueOf).collect(Collectors.joining(","));
    }

    private static List<Integer> ints(String text) {
        if (text == null || text.isBlank()) {
            return List.of();
        }
        return java.util.Arrays.stream(text.split(",")).map(Integer::parseInt).toList();
    }

    private static String encodeCounts(Map<Integer, Long> m) {
        return m.entrySet().stream().sorted(Map.Entry.comparingByKey()).map(e -> e.getKey() + ":" + e.getValue())
                .collect(Collectors.joining(","));
    }

    private static Map<Integer, Long> decodeCounts(String text) {
        Map<Integer, Long> out = new HashMap<>();
        if (text != null && !text.isBlank()) {
            for (String kv : text.split(",")) {
                int c = kv.indexOf(':');
                out.put(Integer.parseInt(kv.substring(0, c)), Long.parseLong(kv.substring(c + 1)));
            }
        }
        return out;
    }

    private static void upsertShapes(Connection c, String sourceId, List<LineShape> shapes) throws SQLException {
        // Called inside the caller's transaction (append) or on its own small set (backfill).
        if (shapes == null || shapes.isEmpty()) {
            return;
        }
        try (PreparedStatement up = c.prepareStatement("INSERT INTO " + SqliteLogsRepository.shapes(sourceId)
                + " (id, fields, line_count, field_counts) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                + "fields = excluded.fields, line_count = excluded.line_count, field_counts = excluded.field_counts")) {
            for (LineShape sh : shapes) {
                up.setInt(1, sh.id());
                up.setString(2, join(sh.fields()));
                up.setLong(3, sh.lineCount());
                up.setString(4, encodeCounts(sh.fieldCounts()));
                up.addBatch();
            }
            up.executeBatch();
        }
    }

    @Override
    public List<LineShape> shapes(String sourceId) {
        return shapeCache.computeIfAbsent(sourceId, this::readShapes);
    }

    private List<LineShape> readShapes(String sourceId) {
        return jdbc().query("SELECT * FROM " + SqliteLogsRepository.shapes(sourceId) + " ORDER BY id", (rs, i) ->
                new LineShape(rs.getInt("id"), rs.getString("name"), rs.getString("template"), ints(rs.getString("fields")),
                        rs.getLong("line_count"), decodeCounts(rs.getString("field_counts"))));
    }

    @Override
    public Map<Integer, Long> shapeCounts(String sourceId, LogStructure structure, LogQuery query) {
        Sql w = SqliteLogQueryTranslator.where(sourceId, structure, query);
        Map<Integer, Long> out = new LinkedHashMap<>();
        jdbc().query("SELECT coalesce(shape, 0) s, count(*) n FROM " + SqliteLogsRepository.lines(sourceId) + " WHERE " + w.where()
                + " GROUP BY s ORDER BY n DESC", rs -> {
            out.put(rs.getInt("s"), rs.getLong("n"));
        }, w.params().toArray());
        return out;
    }

    @Override
    public void saveShapeSettings(String sourceId, int shapeId, String name, String template) {
        jdbc().update("UPDATE " + SqliteLogsRepository.shapes(sourceId) + " SET name = ?, template = ? WHERE id = ?",
                name == null || name.isBlank() ? null : name.strip(), template == null || template.isBlank() ? null : template, shapeId);
        shapeCache.remove(sourceId);
    }

    @Override
    public void upsertShapes(String sourceId, List<LineShape> shapes) {
        try (Connection c = repository.dataSource().getConnection()) {
            upsertShapes(c, sourceId, shapes);
        } catch (SQLException e) {
            throw new IllegalStateException("Could not store structures for " + sourceId, e);
        } finally {
            shapeCache.remove(sourceId);
        }
    }

    @Override
    public void recountShapes(String sourceId, List<FieldDef> storedFields) {
        Set<String> have = columnsOf(sourceId);
        List<FieldDef> cols = storedFields.stream().filter(f -> have.contains(SqliteLogQueryTranslator.text(f))).toList();
        StringBuilder sql = new StringBuilder("SELECT shape, count(*) n");
        cols.forEach(f -> sql.append(", count(").append(SqliteLogQueryTranslator.text(f)).append(")"));
        sql.append(" FROM ").append(SqliteLogsRepository.lines(sourceId)).append(" WHERE shape IS NOT NULL GROUP BY shape");
        Map<Integer, Long> lineCounts = new HashMap<>();
        Map<Integer, Map<Integer, Long>> fieldCounts = new HashMap<>();
        jdbc().query(sql.toString(), rs -> {
            Map<Integer, Long> fc = new HashMap<>();
            for (int k = 0; k < cols.size(); k++) {
                long n = rs.getLong(k + 3);
                if (n > 0) {
                    fc.put(cols.get(k).index(), n);
                }
            }
            lineCounts.put(rs.getInt("shape"), rs.getLong("n"));
            fieldCounts.put(rs.getInt("shape"), fc);
        });
        String ls = SqliteLogsRepository.shapes(sourceId);
        List<Object[]> updates = new ArrayList<>();
        for (LineShape sh : shapes(sourceId)) {
            updates.add(new Object[]{lineCounts.getOrDefault(sh.id(), 0L), encodeCounts(fieldCounts.getOrDefault(sh.id(), Map.of())), sh.id()});
        }
        batchInOneTransaction("UPDATE " + ls + " SET line_count = ?, field_counts = ? WHERE id = ?", updates);
        jdbc().update("DELETE FROM " + ls + " WHERE line_count = 0");
        shapeCache.remove(sourceId);
    }

    @Override
    public void forEachShapeRaw(String sourceId, int shapeId, Consumer<String> consumer) {
        jdbc().query("SELECT raw FROM " + SqliteLogsRepository.lines(sourceId) + " WHERE shape = ? AND raw IS NOT NULL ORDER BY rid",
                rs -> {
                    consumer.accept(rs.getString(1));
                }, shapeId);
    }

    @Override
    public long deleteShape(String sourceId, int shapeId) {
        return deleteWhere(sourceId, "shape = ? AND pinned = 0", shapeId);
    }

    @Override
    public boolean hasUnshaped(String sourceId) {
        return !jdbc().queryForList("SELECT 1 FROM " + SqliteLogsRepository.lines(sourceId) + " WHERE shape IS NULL AND unparsed = 0 LIMIT 1")
                .isEmpty();
    }

    @Override
    public void forEachUnshaped(String sourceId, List<FieldDef> fields, int chunk, Consumer<List<StoredRow>> consumer) {
        Set<String> have = columnsOf(sourceId);
        List<FieldDef> cols = fields.stream().filter(f -> have.contains(SqliteLogQueryTranslator.text(f))).toList();
        String select = "SELECT rid, line_id, raw, mismatch" + cols.stream().map(f -> ", " + SqliteLogQueryTranslator.text(f))
                .collect(Collectors.joining()) + " FROM " + SqliteLogsRepository.lines(sourceId)
                + " WHERE shape IS NULL AND unparsed = 0 AND rid > ? ORDER BY rid LIMIT ?";
        long after = 0;
        while (true) {
            List<StoredRow> rows = jdbc().query(select, (rs, i) -> row(rs, cols, rs.getInt("mismatch") == 1), after, chunk);
            if (rows.isEmpty()) {
                return;
            }
            consumer.accept(rows);
            after = rows.get(rows.size() - 1).rid();
        }
    }

    private static StoredRow row(ResultSet rs, List<FieldDef> cols, boolean mismatch) throws SQLException {
        Map<Integer, String> text = new HashMap<>();
        for (FieldDef f : cols) {
            String v = rs.getString(SqliteLogQueryTranslator.text(f));
            if (v != null) {
                text.put(f.index(), v);
            }
        }
        return new StoredRow(rs.getLong("rid"), rs.getString("line_id"), text, rs.getString("raw"), mismatch);
    }

    @Override
    public void setShapes(String sourceId, Map<Long, Integer> shapeByRid) {
        batchInOneTransaction("UPDATE " + SqliteLogsRepository.lines(sourceId) + " SET shape = ?, mismatch = 0 WHERE rid = ?",
                shapeByRid.entrySet().stream().map(e -> new Object[]{e.getValue(), e.getKey()}).toList());
    }

    /**
     * A batch of updates as ONE transaction. A plain JdbcTemplate batch commits every statement on its
     * own: thousands of commits per chunk, which on a slow disk holds the write lock long enough to
     * starve every other writer into SQLITE_BUSY.
     */
    private void batchInOneTransaction(String sql, List<Object[]> rows) {
        for (int from = 0; from < rows.size(); from += BATCH_TX_ROWS) {
            batchChunk(sql, rows.subList(from, Math.min(rows.size(), from + BATCH_TX_ROWS)));
        }
    }

    /** Short write transactions (a few thousand small updates) so other writers never wait long. */
    static final int BATCH_TX_ROWS = 2_000;

    private void batchChunk(String sql, List<Object[]> rows) {
        if (rows.isEmpty()) {
            return;
        }
        try (Connection c = repository.dataSource().getConnection()) {
            c.setAutoCommit(false);
            try (PreparedStatement ps = c.prepareStatement(sql)) {
                for (Object[] row : rows) {
                    for (int i = 0; i < row.length; i++) {
                        ps.setObject(i + 1, row[i]);
                    }
                    ps.addBatch();
                }
                ps.executeBatch();
                c.commit();
            } catch (SQLException | RuntimeException e) {
                c.rollback();
                throw e;
            } finally {
                c.setAutoCommit(true);
            }
        } catch (SQLException e) {
            throw new IllegalStateException("Could not update log lines", e);
        }
    }

    /** Rows per write transaction in background rewrites: short, so ingest and the UI interleave. */
    static final int REWRITE_TX_ROWS = 500;

    @Override
    public void rewriteLines(String sourceId, LogStructure structure, List<Rewrite> rows) {
        for (int from = 0; from < rows.size(); from += REWRITE_TX_ROWS) {
            rewriteChunk(sourceId, structure, rows.subList(from, Math.min(rows.size(), from + REWRITE_TX_ROWS)));
        }
    }

    private void rewriteChunk(String sourceId, LogStructure structure, List<Rewrite> rows) {
        if (rows.isEmpty()) {
            return;
        }
        List<FieldDef> stored = structure.fields().stream().filter(FieldDef::stored).toList();
        ensureFields(sourceId, stored);
        Set<String> have = columnsOf(sourceId);
        List<FieldDef> typed = stored.stream().filter(f -> have.contains(SqliteLogQueryTranslator.typedCol(f))).toList();
        StringBuilder set = new StringBuilder("shape = ?, mismatch = 0");
        stored.forEach(f -> set.append(", ").append(SqliteLogQueryTranslator.text(f)).append(" = ?"));
        typed.forEach(f -> set.append(", ").append(SqliteLogQueryTranslator.typedCol(f)).append(" = ?"));
        String fts = SqliteLogsRepository.fts(sourceId);
        try (Connection c = repository.dataSource().getConnection()) {
            c.setAutoCommit(false);
            try (PreparedStatement up = c.prepareStatement("UPDATE " + SqliteLogsRepository.lines(sourceId) + " SET " + set + " WHERE rid = ?");
                 PreparedStatement del = c.prepareStatement("DELETE FROM " + fts + " WHERE rowid = ?");
                 PreparedStatement ins = c.prepareStatement("INSERT INTO " + fts + " (rowid, txt) VALUES (?, ?)")) {
                for (Rewrite r : rows) {
                    int i = 1;
                    up.setInt(i++, r.shape());
                    for (FieldDef f : stored) {
                        up.setString(i++, r.text().get(f.index()));
                    }
                    for (FieldDef f : typed) {
                        up.setObject(i++, r.typed().get(f.index()));
                    }
                    up.setLong(i, r.rid());
                    up.addBatch();
                    del.setLong(1, r.rid());
                    del.addBatch();
                    if (r.ftsText() != null && !r.ftsText().isEmpty()) {
                        ins.setLong(1, r.rid());
                        ins.setString(2, r.ftsText());
                        ins.addBatch();
                    }
                }
                up.executeBatch();
                del.executeBatch();
                ins.executeBatch();
                c.commit();
            } catch (SQLException | RuntimeException e) {
                c.rollback();
                throw e;
            } finally {
                c.setAutoCommit(true);
            }
        } catch (SQLException e) {
            throw new IllegalStateException("Could not rewrite log lines for " + sourceId, e);
        }
    }

    @Override
    public void forEachChunk(String sourceId, List<FieldDef> fields, int chunk, Consumer<List<StoredRow>> consumer) {
        String ll = SqliteLogsRepository.lines(sourceId);
        Set<String> have = columnsOf(sourceId);
        List<FieldDef> cols = fields.stream().filter(f -> have.contains(SqliteLogQueryTranslator.text(f))).toList();
        String select = "SELECT rid, line_id, raw" + cols.stream().map(f -> ", " + SqliteLogQueryTranslator.text(f)).collect(Collectors.joining())
                + " FROM " + ll + " WHERE rid > ? ORDER BY rid LIMIT ?";
        long after = 0;
        while (true) {
            List<StoredRow> rows = jdbc().query(select, (rs, i) -> row(rs, cols, false), after, chunk);
            if (rows.isEmpty()) {
                return;
            }
            consumer.accept(rows);
            after = rows.get(rows.size() - 1).rid();
        }
    }

    @Override
    public void updateTyped(String sourceId, FieldDef field, List<Long> rids, List<Object> values) {
        ensureFields(sourceId, List.of(field));
        List<Object[]> args = new ArrayList<>();
        for (int i = 0; i < rids.size(); i++) {
            args.add(new Object[]{values.get(i), rids.get(i)});
        }
        batchInOneTransaction("UPDATE " + SqliteLogsRepository.lines(sourceId) + " SET " + SqliteLogQueryTranslator.typedCol(field)
                + " = ? WHERE rid = ?", args);
    }

    @Override
    public void updateDerived(String sourceId, List<Derived> rows) {
        batchInOneTransaction("UPDATE " + SqliteLogsRepository.lines(sourceId) + " SET ts_ms = ?, level = ?, group_level = ?, group_path = ?, "
                        + "missing_level = ?, pattern_id = ?, duration = ? WHERE rid = ?",
                rows.stream().map(d -> new Object[]{d.ts(), d.level(), d.groupLevel(), d.groupPath(), d.missingLevel(), d.patternId(),
                        d.duration() == 0 ? null : d.duration(), d.rid()}).toList());
    }

    @Override
    public void rebuildFts(String sourceId, List<FieldDef> textFields) {
        String fts = SqliteLogsRepository.fts(sourceId);
        jdbc().execute("INSERT INTO " + fts + " (" + fts + ") VALUES ('delete-all')");
        Set<String> have = columnsOf(sourceId);
        List<String> cols = textFields.stream().map(SqliteLogQueryTranslator::text).filter(have::contains).toList();
        if (cols.isEmpty()) {
            return;
        }
        jdbc().execute("INSERT INTO " + fts + " (rowid, txt) SELECT rid, txt FROM (SELECT rid, concat_ws(char(10), "
                + String.join(", ", cols) + ") txt FROM " + SqliteLogsRepository.lines(sourceId) + ") WHERE txt <> ''");
    }

    /**
     * Page cursor of a field sort: the last row's sort value (null = the lines lacking the field, which
     * come last), time and rowid. Typed so a number is compared as a number on the next page.
     */
    record FieldCursor(Object value, long ts, long rid) {

        String encode() {
            String v = value == null ? "-" : (value instanceof Number ? "n" : "s")
                    + java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(String.valueOf(value).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return "f:" + ts + ":" + rid + ":" + v;
        }

        static FieldCursor parse(String cursor) {
            String[] c = cursor.split(":", 4);
            if (c.length != 4 || !"f".equals(c[0])) {
                throw new IllegalArgumentException("This page cursor belongs to another sort - reload the list");
            }
            Object v = null;
            if (!"-".equals(c[3])) {
                String text = new String(java.util.Base64.getUrlDecoder().decode(c[3].substring(1)), java.nio.charset.StandardCharsets.UTF_8);
                v = c[3].charAt(0) == 'n' ? (Object) Double.parseDouble(text) : text;
            }
            return new FieldCursor(v, Long.parseLong(c[1]), Long.parseLong(c[2]));
        }
    }
}
