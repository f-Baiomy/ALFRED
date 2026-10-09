package com.fathy.alfred.dbagent;

/**
 * The agent's only output - into the application's own console, so it must stay rare: at most one line per minute per
 * kind, and never a statement, a value or the secret.
 *
 * <p>A server can route {@code System.err} into its logging (WildFly logs it as ERROR on the "stderr" logger), where the
 * agent's own log hooks would catch it as an application line of whatever call the thread was running - a call that
 * succeeded then showed an ERROR and was triaged as a hidden failure. So every line is printed with {@link #printing()}
 * set for the thread, and starts with {@link #PREFIX}; the log catcher drops both (the prefix also covers a line printed
 * by an older copy of the agent still loaded in the same JVM, whose flag this copy cannot see).
 */
public final class AgentLog {

    public static final String PREFIX = "[alfred-agent] ";

    private static final long QUIET_MILLIS = 60_000;
    private static final java.util.concurrent.ConcurrentHashMap<String, Long> LAST = new java.util.concurrent.ConcurrentHashMap<>();
    private static final ThreadLocal<boolean[]> PRINTING = ThreadLocal.withInitial(() -> new boolean[1]);

    private AgentLog() {
    }

    public static void info(String message) {
        print(PREFIX + message);
    }

    /** Rate-limited per message. */
    public static void warn(String message) {
        long now = System.currentTimeMillis();
        Long last = LAST.get(message);
        if (last == null || now - last > QUIET_MILLIS) {
            LAST.put(message, now);
            print(PREFIX + "WARN " + message);
        }
    }

    /** An agent bug must never become the application's bug: report the kind, swallow the error. */
    public static void failure(String where, Throwable t) {
        warn(where + " failed: " + t.getClass().getName());
    }

    /** True while this thread prints an agent line - anything logged now is the agent's own output. */
    public static boolean printing() {
        return PRINTING.get()[0];
    }

    /** A message the agent wrote, however it came back (System.err routed into the server's logging). */
    public static boolean isOwn(String message) {
        return message != null && message.startsWith(PREFIX);
    }

    private static void print(String line) {
        boolean[] flag = PRINTING.get();
        flag[0] = true;
        try {
            System.err.println(line);
        } finally {
            flag[0] = false;
        }
    }
}
