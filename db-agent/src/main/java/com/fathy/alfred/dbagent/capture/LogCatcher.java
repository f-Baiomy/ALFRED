package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.AgentLog;
import com.fathy.alfred.dbagent.transport.LogRecord;
import com.fathy.alfred.dbagent.transport.StatementSink;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Method;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Turns a log event the application emitted into a {@link LogRecord} of its call (specs/009-agent-log-capture,
 * research R1/R2/R6). The event is read reflectively - the agent depends on no logging framework - through a method
 * cache per event class. Called only at the outermost logging hook on a thread (the dispatcher's depth counter), so
 * a line passing through bridges (slf4j → logback, JUL → logmanager) is caught once. Never throws.
 */
public final class LogCatcher {

    /** Per call (research R6): lines, characters (2 MB of UTF-16), characters per line (32 KB). */
    static final int MAX_LINES_PER_CALL = 5_000;
    static final long MAX_CHARS_PER_CALL = 1_000_000;
    static final int MAX_CHARS_PER_LINE = 16_000;
    /** Lines of work that ends after its request are kept this long after the request ended (FR-013). */
    static final long LATE_GRACE_NANOS = 5_000_000_000L;
    /** Outside-call lines per minute per JVM - a startup storm or a chatty job cannot flood the queue. */
    static final int MAX_OUTSIDE_PER_MINUTE = 2_000;

    private static final DateTimeFormatter AT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);
    private static final Object NONE = new Object();

    private final StatementSink sink;
    private final Map<String, Object> methods = new ConcurrentHashMap<>();
    private volatile long outsideMinute;
    private final java.util.concurrent.atomic.AtomicInteger outsideInMinute = new java.util.concurrent.atomic.AtomicInteger();
    /**
     * JUL's message formatting (parameters, resource bundles) - the same text a JUL handler would print. Created on the
     * first JUL event, never earlier: touching java.util.logging while the agent starts (premain) fixes the JVM's
     * LogManager before an application server installs its own - WildFly then refuses to boot (WFLYLOG0078).
     */
    private volatile Object julFormatter;

    LogCatcher(StatementSink sink) {
        this.sink = sink;
    }

    /** The framework a hooked class belongs to (the advice passes the hooked method's declaring type). */
    static String kindOf(String type) {
        if (type == null) {
            return null;
        }
        switch (type) {
            case "org.jboss.logmanager.Logger":
                return "jboss";
            case "java.util.logging.Logger":
                return "jul";
            case "ch.qos.logback.classic.Logger":
                return "logback";
            case "org.apache.logging.log4j.core.config.LoggerConfig":
                return "log4j2";
            case "org.apache.log4j.Category":
                return "log4j1";
            default:
                return null;
        }
    }

    /** JUL's own decision for this record (level and filter), taken before any handler sees it - nothing more is caught. */
    static boolean julLoggable(Object logger, Object record) {
        if (!(logger instanceof java.util.logging.Logger) || !(record instanceof java.util.logging.LogRecord)) {
            return false;
        }
        java.util.logging.Logger l = (java.util.logging.Logger) logger;
        java.util.logging.LogRecord r = (java.util.logging.LogRecord) record;
        if (!l.isLoggable(r.getLevel())) {
            return false;
        }
        java.util.logging.Filter filter = l.getFilter();
        return filter == null || filter.isLoggable(r);
    }

    /**
     * One event. {@code context} is the thread's call (null outside any call); {@code outside} says whether
     * outside-call lines are wanted (▤ on for the project).
     */
    void caught(String kind, Object event, CallContext context, boolean outside) {
        caught(kind, event, context, outside, 0);
    }

    /** {@code minRank}: the project's Log level ({@link #rank}); a line below it is not caught and counts toward no cap. */
    void caught(String kind, Object event, CallContext context, boolean outside, int minRank) {
        if (event == null || AgentLog.printing()) {
            return;
        }
        if (minRank > 0 && rankOf(kind, event) < minRank) {
            return;
        }
        if (context != null) {
            if (!context.logs) {
                return;
            }
            long closed = context.closedAtNanos;
            if (closed != 0 && System.nanoTime() - closed > LATE_GRACE_NANOS) {
                sink.droppedLogs(context.callId, 1);
                return;
            }
            if (context.logLines.incrementAndGet() > MAX_LINES_PER_CALL) {
                sink.droppedLogs(context.callId, 1);
                return;
            }
        } else if (!outside || !outsideAllowed()) {
            return;
        }
        LogRecord r = read(kind, event);
        if (r == null || AgentLog.isOwn(r.message)) {
            return;
        }
        int chars = cap(r);
        if (context != null) {
            if (context.logChars.addAndGet(chars) > MAX_CHARS_PER_CALL) {
                sink.droppedLogs(context.callId, 1);
                return;
            }
            r.callId = context.callId;
            r.seq = context.nextSeq();
        }
        sink.log(r);
    }

    /** The event's level on one scale: 5 ERROR, 4 WARN, 3 INFO, 2 DEBUG, 1 TRACE; an unreadable level keeps the line (5). */
    private int rankOf(String kind, Object event) {
        try {
            Object level = "jul".equals(kind) ? ((java.util.logging.LogRecord) event).getLevel() : call(event, "getLevel");
            return rank(level);
        } catch (Throwable t) {
            return 5;
        }
    }

    static int rank(Object level) {
        if (level == null) {
            return 5;
        }
        if (level instanceof java.util.logging.Level) {
            // JUL and jboss-logmanager (ERROR 1000, WARN 900, INFO 800, CONFIG 700, DEBUG/FINE 500, TRACE 400, FINER/FINEST)
            int v = ((java.util.logging.Level) level).intValue();
            return v >= 1000 ? 5 : v >= 900 ? 4 : v >= 700 ? 3 : v >= 500 ? 2 : 1;
        }
        switch (level.toString().trim().toUpperCase(java.util.Locale.ROOT)) {
            case "TRACE":
            case "FINER":
            case "FINEST":
            case "ALL":
                return 1;
            case "DEBUG":
            case "FINE":
                return 2;
            case "INFO":
            case "CONFIG":
            case "NOTICE":
                return 3;
            case "WARN":
            case "WARNING":
                return 4;
            default:
                return 5; // ERROR, FATAL, SEVERE and anything unknown - never lose a line we cannot place
        }
    }

    private boolean outsideAllowed() {
        long minute = System.currentTimeMillis() / 60_000;
        if (minute != outsideMinute) {
            outsideMinute = minute;
            outsideInMinute.set(0);
        }
        return outsideInMinute.incrementAndGet() <= MAX_OUTSIDE_PER_MINUTE;
    }

    /** The event's fields; null when it cannot be read at all. */
    LogRecord read(String kind, Object e) {
        try {
            LogRecord r = new LogRecord();
            Throwable thrown;
            long millis;
            switch (kind) {
                case "jboss":
                    r.level = name(call(e, "getLevel"));
                    r.logger = str(call(e, "getLoggerName"));
                    r.thread = str(call(e, "getThreadName"));
                    r.message = message(e, "getFormattedMessage", "getMessage");
                    thrown = (Throwable) call(e, "getThrown");
                    millis = num(call(e, "getMillis"));
                    break;
                case "jul": {
                    java.util.logging.LogRecord jul = (java.util.logging.LogRecord) e;
                    r.level = jul.getLevel() == null ? null : jul.getLevel().getName();
                    r.logger = jul.getLoggerName();
                    r.thread = Thread.currentThread().getName();
                    String text;
                    try {
                        Object formatter = julFormatter;
                        if (formatter == null) {
                            formatter = new java.util.logging.SimpleFormatter();
                            julFormatter = formatter;
                        }
                        text = ((java.util.logging.Formatter) formatter).formatMessage(jul);
                    } catch (RuntimeException ex) {
                        text = jul.getMessage();
                    }
                    r.message = text;
                    thrown = jul.getThrown();
                    millis = jul.getMillis();
                    break;
                }
                case "logback":
                    r.level = str(call(e, "getLevel"));
                    r.logger = str(call(e, "getLoggerName"));
                    r.thread = str(call(e, "getThreadName"));
                    r.message = message(e, "getFormattedMessage", "getMessage");
                    thrown = logbackThrowable(call(e, "getThrowableProxy"));
                    millis = num(call(e, "getTimeStamp"));
                    break;
                case "log4j2": {
                    r.level = name(call(e, "getLevel"));
                    r.logger = str(call(e, "getLoggerName"));
                    r.thread = str(call(e, "getThreadName"));
                    Object msg = call(e, "getMessage");
                    r.message = msg == null ? null : message(msg, "getFormattedMessage", "getFormat");
                    thrown = (Throwable) call(e, "getThrown");
                    millis = num(call(e, "getTimeMillis"));
                    break;
                }
                case "log4j1": {
                    r.level = str(call(e, "getLevel"));
                    r.logger = str(call(e, "getLoggerName"));
                    r.thread = str(call(e, "getThreadName"));
                    r.message = message(e, "getRenderedMessage", "getMessage");
                    Object info = call(e, "getThrowableInformation");
                    thrown = info == null ? null : (Throwable) call(info, "getThrowable");
                    Object ts = call(e, "getTimeStamp");
                    millis = ts == null ? System.currentTimeMillis() : num(ts);
                    break;
                }
                default:
                    return null;
            }
            r.at = AT.format(Instant.ofEpochMilli(millis > 0 ? millis : System.currentTimeMillis()));
            if (r.thread == null) {
                r.thread = Thread.currentThread().getName();
            }
            if (thrown != null) {
                r.exceptionType = thrown.getClass().getName();
                r.exceptionMessage = thrown.getMessage();
                StringWriter out = new StringWriter();
                thrown.printStackTrace(new PrintWriter(out));
                r.exceptionStack = out.toString();
            }
            return r;
        } catch (Throwable t) {
            AgentLog.failure("log catching (" + kind + ")", t);
            return null;
        }
    }

    /** Cuts the message and the stack to the per-line cap; returns the characters kept. */
    static int cap(LogRecord r) {
        int budget = MAX_CHARS_PER_LINE;
        r.message = cut(r, r.message, budget);
        budget -= length(r.message);
        r.exceptionMessage = cut(r, r.exceptionMessage, budget);
        budget -= length(r.exceptionMessage);
        r.exceptionStack = cut(r, r.exceptionStack, budget);
        return length(r.message) + length(r.exceptionMessage) + length(r.exceptionStack);
    }

    private static int length(String s) {
        return s == null ? 0 : s.length();
    }

    private static String cut(LogRecord r, String s, int max) {
        if (s == null || s.length() <= max) {
            return s;
        }
        r.cut = true;
        return s.substring(0, max);
    }

    /** logback's IThrowableProxy: the Throwable itself when it is a ThrowableProxy, else a stand-in with its class and message. */
    private Throwable logbackThrowable(Object proxy) throws Exception {
        if (proxy == null) {
            return null;
        }
        Object t = call(proxy, "getThrowable");
        if (t instanceof Throwable) {
            return (Throwable) t;
        }
        return new RuntimeException(str(call(proxy, "getClassName")) + ": " + str(call(proxy, "getMessage")));
    }

    private String message(Object e, String formatted, String fallback) {
        try {
            Object text = call(e, formatted);
            return text == null ? null : text.toString();
        } catch (Throwable t) {
            // a parameter whose toString throws: the application's own output is unaffected; keep the raw pattern
            AgentLog.failure("log message formatting", t);
            try {
                return str(call(e, fallback));
            } catch (Throwable ignored) {
                return null;
            }
        }
    }

    private Object call(Object target, String name) throws Exception {
        String key = target.getClass().getName() + '#' + name + '@' + System.identityHashCode(target.getClass());
        Object m = methods.get(key);
        if (m == null) {
            m = find(target.getClass(), name);
            methods.put(key, m == null ? NONE : m);
        }
        if (m == NONE || m == null) {
            return null;
        }
        try {
            return ((Method) m).invoke(target);
        } catch (java.lang.reflect.InvocationTargetException ex) {
            Throwable cause = ex.getCause();
            if (cause instanceof Exception) {
                throw (Exception) cause;
            }
            throw ex;
        }
    }

    private static Method find(Class<?> type, String name) {
        for (Class<?> c = type; c != null; c = c.getSuperclass()) {
            for (Class<?> i : c.getInterfaces()) {
                Method m = publicMethod(i, name);
                if (m != null) {
                    return m;
                }
            }
        }
        Method m = publicMethod(type, name);
        if (m != null && !java.lang.reflect.Modifier.isPublic(m.getDeclaringClass().getModifiers())) {
            m.setAccessible(true);
        }
        return m;
    }

    private static Method publicMethod(Class<?> type, String name) {
        try {
            return type.getMethod(name);
        } catch (NoSuchMethodException | SecurityException e) {
            return null;
        }
    }

    private static String str(Object o) {
        return o == null ? null : o.toString();
    }

    private static String name(Object level) throws Exception {
        if (level == null) {
            return null;
        }
        if (level instanceof java.util.logging.Level) {
            return ((java.util.logging.Level) level).getName();
        }
        try {
            Method m = level.getClass().getMethod("name");
            return String.valueOf(m.invoke(level));
        } catch (NoSuchMethodException e) {
            return level.toString();
        }
    }

    private static long num(Object o) {
        return o instanceof Number ? ((Number) o).longValue() : 0;
    }
}
