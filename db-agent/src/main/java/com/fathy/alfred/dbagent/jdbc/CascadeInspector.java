package com.fathy.alfred.dbagent.jdbc;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Which tables a DELETE on a table cascades into ({@code ON DELETE CASCADE} foreign keys) - the database removes those
 * child rows itself and JDBC never reports them, so the window warns. Asked once per table per database (the
 * metadata query is cached), never per statement.
 */
public final class CascadeInspector {

    private static final ConcurrentHashMap<String, List<String>> CACHE = new ConcurrentHashMap<>();
    private static final int CACHE_LIMIT = 2048;

    private CascadeInspector() {
    }

    public static List<String> cascadesTo(Connection connection, String dataSource, String table) {
        if (table == null || connection == null) {
            return Collections.emptyList();
        }
        String key = dataSource + "|" + table.toLowerCase(Locale.ROOT);
        List<String> known = CACHE.get(key);
        if (known != null) {
            return known;
        }
        List<String> found = lookUp(connection, table);
        if (CACHE.size() >= CACHE_LIMIT) {
            CACHE.clear();
        }
        CACHE.put(key, found);
        return found;
    }

    private static List<String> lookUp(Connection connection, String table) {
        String bare = table.replace("\"", "").replace("`", "");
        String schema = null;
        int dot = bare.lastIndexOf('.');
        if (dot > 0) {
            schema = bare.substring(0, dot);
            bare = bare.substring(dot + 1);
        }
        Set<String> children = new LinkedHashSet<>();
        try {
            DatabaseMetaData meta = connection.getMetaData();
            // Identifiers are stored upper-case (Oracle, H2), lower-case (PostgreSQL) or as written (MySQL, SQL Server).
            for (String name : new String[]{bare, bare.toUpperCase(Locale.ROOT), bare.toLowerCase(Locale.ROOT)}) {
                try (ResultSet rs = meta.getExportedKeys(null, schema == null ? null : name.equals(bare) ? schema : schema.toUpperCase(Locale.ROOT), name)) {
                    while (rs.next()) {
                        if (rs.getShort("DELETE_RULE") == DatabaseMetaData.importedKeyCascade) {
                            children.add(rs.getString("FKTABLE_NAME").toLowerCase(Locale.ROOT));
                        }
                    }
                }
                if (!children.isEmpty()) {
                    break;
                }
            }
        } catch (Throwable ignored) {
            // A driver without (working) metadata: no cascade information, never an error for the application.
        }
        return Collections.unmodifiableList(new ArrayList<>(children));
    }
}
