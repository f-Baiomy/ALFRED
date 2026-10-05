package com.fathy.alfred.dbagent.jdbc;

import com.fathy.alfred.dbagent.transport.IndexRecord;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * A table's indexes ("is there one on the column this slow query filters by?") - opt-in per project (Settings →
 * Database capture → Index check). Database METADATA only, through {@link DatabaseMetaData#getIndexInfo} with
 * {@code approximate = true}: Oracle's driver runs {@code ANALYZE TABLE ... COMPUTE STATISTICS} when it is false, and
 * the agent never changes anything in the database. EXPLAIN is never run. Cached per data source and table for ten
 * minutes, so a table costs one metadata read however many statements touch it.
 */
public final class IndexInspector {

    private static final long TTL_NANOS = TimeUnit.MINUTES.toNanos(10);
    private static final int CACHE_LIMIT = 2048;
    private static final ConcurrentHashMap<String, Cached> CACHE = new ConcurrentHashMap<>();

    private IndexInspector() {
    }

    private static final class Cached {
        final List<IndexRecord> indexes;
        final long at;

        Cached(List<IndexRecord> indexes, long at) {
            this.indexes = indexes;
            this.at = at;
        }
    }

    public static List<IndexRecord> indexesOf(Connection connection, String dataSource, String table) {
        if (table == null || connection == null) {
            return Collections.emptyList();
        }
        String key = dataSource + "|" + table.toLowerCase(Locale.ROOT);
        long now = System.nanoTime();
        Cached known = CACHE.get(key);
        if (known != null && now - known.at < TTL_NANOS) {
            return known.indexes;
        }
        List<IndexRecord> found = lookUp(connection, table);
        if (CACHE.size() >= CACHE_LIMIT) {
            CACHE.clear();
        }
        CACHE.put(key, new Cached(found, now));
        return found;
    }

    private static List<IndexRecord> lookUp(Connection connection, String table) {
        String bare = table.replace("\"", "").replace("`", "");
        String schema = null;
        int dot = bare.lastIndexOf('.');
        if (dot > 0) {
            schema = bare.substring(0, dot);
            bare = bare.substring(dot + 1);
        }
        try {
            DatabaseMetaData meta = connection.getMetaData();
            // Identifiers are stored upper-case (Oracle, H2), lower-case (PostgreSQL) or as written (MySQL, SQL Server).
            for (String name : new String[]{bare, bare.toUpperCase(Locale.ROOT), bare.toLowerCase(Locale.ROOT)}) {
                String s = schema == null ? null : name.equals(bare) ? schema : schema.toUpperCase(Locale.ROOT);
                Map<String, IndexRecord> byName = new LinkedHashMap<>();
                try (ResultSet rs = meta.getIndexInfo(null, s, name, false, true)) {
                    while (rs.next()) {
                        if (rs.getShort("TYPE") == DatabaseMetaData.tableIndexStatistic) {
                            continue;
                        }
                        String index = rs.getString("INDEX_NAME");
                        String column = rs.getString("COLUMN_NAME");
                        if (index == null || column == null) {
                            continue;
                        }
                        IndexRecord r = byName.get(index);
                        if (r == null) {
                            r = new IndexRecord();
                            r.name = index;
                            r.unique = !rs.getBoolean("NON_UNIQUE");
                            r.columns = new ArrayList<>();
                            byName.put(index, r);
                        }
                        r.columns.add(column);
                    }
                }
                if (!byName.isEmpty()) {
                    return Collections.unmodifiableList(new ArrayList<>(byName.values()));
                }
            }
        } catch (Throwable t) {
            // no metadata for this table (a view, a synonym, no rights) - nothing to say about indexes
        }
        return Collections.emptyList();
    }
}
