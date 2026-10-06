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
    public static final int DEFAULT_CALLER_FRAMES = 5;
    /** Application frames recorded per statement, past {@link #passThrough} (Settings → Database capture). */
    private volatile int callerFrames = DEFAULT_CALLER_FRAMES;
    private volatile PassThrough passThrough = PassThrough.NONE;
    /** Read a slow statement's table's index list (metadata only) - opt-in per project. */
    private volatile boolean indexInfo;
    /** The project's ▤ is on: lines outside any call are caught too (specs/009-agent-log-capture). */
    private volatile boolean logsOutside;
    /**
     * The lowest level of line caught (Settings → Database capture → Log level): 5 ERROR (the default), 4 WARN, 3 INFO,
     * 2 DEBUG, 1 TRACE, 0 whatever the application writes. Never below the application's own level - the hooks sit
     * after its check, and the agent never changes what it logs.
     */
    private volatile int logMinRank = LOG_ERROR;
    /** The setting's name as applied (ERROR when none or unknown) - sent on each CALL_OPEN (specs/010, per-call level). */
    private volatile String logLevelName = "ERROR";
    public static final int LOG_ERROR = 5;
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

    public boolean logsOutside() {
        return logsOutside;
    }

    public void applyLogs(boolean on) {
        this.logsOutside = on;
    }

    public int logMinRank() {
        return logMinRank;
    }

    /** ERROR, WARN, INFO, DEBUG, TRACE or APP (the application's own level); anything else, or none, is ERROR. */
    public String logLevelName() {
        return logLevelName;
    }

    public void applyLogLevel(String level) {
        int rank = levelSetting(level);
        this.logMinRank = rank;
        this.logLevelName = rank == 0 ? "APP" : new String[]{"APP", "TRACE", "DEBUG", "INFO", "WARN", "ERROR"}[rank];
    }

    static int levelSetting(String level) {
        if (level == null) {
            return LOG_ERROR;
        }
        switch (level.trim().toUpperCase(Locale.ROOT)) {
            case "APP":
                return 0;
            case "TRACE":
                return 1;
            case "DEBUG":
                return 2;
            case "INFO":
                return 3;
            case "WARN":
                return 4;
            default:
                return LOG_ERROR;
        }
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

    public int callerFrames() {
        return callerFrames;
    }

    public PassThrough passThrough() {
        return passThrough;
    }

    public boolean indexInfo() {
        return indexInfo;
    }

    public void apply(int rows, Set<String> tables, boolean outside, boolean enabled, List<String> ignore) {
        apply(rows, tables, outside, enabled, ignore, Collections.<String>emptyList(), DEFAULT_CALLER_FRAMES, false);
    }

    public void apply(int rows, Set<String> tables, boolean outside, boolean enabled, List<String> ignore, List<String> passThroughClasses,
                      int frames, boolean index) {
        this.callerFrames = frames <= 0 ? DEFAULT_CALLER_FRAMES : Math.min(frames, 10);
        if (!passThroughClasses.equals(this.passThrough.asList())) {
            this.passThrough = new PassThrough(passThroughClasses);
        }
        this.indexInfo = index;
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
