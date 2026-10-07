package com.fathy.alfred.dbagent;

/**
 * The agent's only output - into the application's own console, so it must stay rare: at most one line per minute per
 * kind, and never a statement, a value or the secret.
 */
public final class AgentLog {

    private static final long QUIET_MILLIS = 60_000;
    private static final java.util.concurrent.ConcurrentHashMap<String, Long> LAST = new java.util.concurrent.ConcurrentHashMap<>();

    private AgentLog() {
    }

    public static void info(String message) {
        System.err.println("[alfred-agent] " + message);
    }

    /** Rate-limited per message. */
    public static void warn(String message) {
        long now = System.currentTimeMillis();
        Long last = LAST.get(message);
        if (last == null || now - last > QUIET_MILLIS) {
            LAST.put(message, now);
            System.err.println("[alfred-agent] WARN " + message);
        }
    }

    /** An agent bug must never become the application's bug: report the kind, swallow the error. */
    public static void failure(String where, Throwable t) {
        warn(where + " failed: " + t.getClass().getName());
    }
}
