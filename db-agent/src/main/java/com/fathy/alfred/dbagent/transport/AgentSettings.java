package com.fathy.alfred.dbagent.transport;

import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Set;

/**
 * What the last heartbeat said (contracts/agent-ingest.md). Until the first answer arrives the agent captures inside
 * calls (the proxy's db=1 already says the project is on) but nothing outside them.
 */
public final class AgentSettings {

    public static final int DEFAULT_ROWS_PER_RESULT = 50_000;

    private volatile int rowsPerResult = DEFAULT_ROWS_PER_RESULT;
    private volatile Set<String> beforeImageTables = Collections.emptySet();
    private volatile boolean outsideCallCapture;
    private volatile boolean captureEnabled;
    private volatile List<String> ignorePatterns = Collections.singletonList("SELECT 1");
    /** Per-SQL answers of {@link #ignored}: matching compiles regexes, far too slow to repeat for every statement.
     *  Replaced (not cleared) when the patterns change, so a reader never mixes old and new answers. */
    private volatile Map<String, Boolean> ignoredCache = new ConcurrentHashMap<>();
    private static final int CACHE_LIMIT = 4096;

    public int rowsPerResult() {
        return rowsPerResult;
    }

    public boolean beforeImageFor(String table) {
        return table != null && beforeImageTables.contains(table.toLowerCase(Locale.ROOT));
    }

    /** Outside-call statements are captured only when the project is switched on AND outside capture is on. */
    public boolean captureOutsideCalls() {
        return captureEnabled && outsideCallCapture;
    }

    /** True when the statement matches an ignore pattern ({@code %} wildcard, case-insensitive, prefix match on the SQL). */
    public boolean ignored(String sql) {
        if (sql == null) {
            return false;
        }
        Map<String, Boolean> cache = ignoredCache;
        Boolean known = cache.get(sql);
        if (known != null) {
            return known;
        }
        boolean result = false;
        String normalized = sql.trim().toUpperCase(Locale.ROOT);
        for (String pattern : ignorePatterns) {
            if (matches(normalized, pattern.trim().toUpperCase(Locale.ROOT))) {
                result = true;
                break;
            }
        }
        if (cache.size() >= CACHE_LIMIT) {
            cache.clear(); // applications with unbounded distinct SQL (literals inlined) must not grow it forever
        }
        cache.put(sql, result);
        return result;
    }

    static boolean matches(String sql, String pattern) {
        if (pattern.isEmpty()) {
            return false;
        }
        if (!pattern.contains("%")) {
            return sql.equals(pattern) || sql.startsWith(pattern + " ") || containsTable(sql, pattern);
        }
        String regex = "\\Q" + pattern.replace("%", "\\E.*\\Q") + "\\E";
        return sql.matches(regex) || sql.matches(".*\\b" + regex + ".*");
    }

    private static boolean containsTable(String sql, String table) {
        return sql.matches(".*\\b(FROM|INTO|UPDATE|JOIN)\\s+" + java.util.regex.Pattern.quote(table) + "\\b.*");
    }

    public void apply(int rows, Set<String> tables, boolean outside, boolean enabled, List<String> ignore) {
        this.rowsPerResult = Math.max(1, rows);
        Set<String> lower = new HashSet<>();
        for (String t : tables) {
            lower.add(t.toLowerCase(Locale.ROOT));
        }
        this.beforeImageTables = Collections.unmodifiableSet(lower);
        this.outsideCallCapture = outside;
        this.captureEnabled = enabled;
        if (!ignore.equals(this.ignorePatterns)) {
            this.ignorePatterns = Collections.unmodifiableList(ignore);
            this.ignoredCache = new ConcurrentHashMap<>();
        }
    }
}
