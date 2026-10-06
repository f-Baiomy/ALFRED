package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.AgentLog;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;

/**
 * Puts the call id under {@code alfred.call} in the application's logging MDCs while a request whose
 * {@code X-Alfred-Call} says {@code log=1} runs (specs/008-logs-call-link/contracts/agent-log-tagging.md), so every
 * line the request writes can be linked to its call exactly. The MDC classes are found through the thread's context
 * class loader - the agent has no logging dependency - probed once per class loader and cached; a missing one is
 * skipped. The previous value is restored afterwards (pool threads are reused). Never throws.
 */
public final class LogTagger {

    public static final String KEY = "alfred.call";

    /** The MDCs a Java application may log through; on WildFly slf4j and jboss-logging share the logmanager's. */
    static final String[] MDC_CLASSES = {
            "org.jboss.logmanager.MDC",
            "org.slf4j.MDC",
            "org.apache.logging.log4j.ThreadContext",
            "org.apache.log4j.MDC",
            "org.jboss.logging.MDC",
    };

    /** The call id this thread's lines are tagged with right now (the work handed to another thread takes it along). */
    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();
    private static final Map<ClassLoader, Mdc[]> BY_LOADER = new WeakHashMap<>();
    private static final Mdc[] NONE = new Mdc[0];

    private LogTagger() {
    }

    /** The call id this thread is tagged with, or null. */
    public static String current() {
        return CURRENT.get();
    }

    /**
     * Tags this thread's MDCs with {@code callId}; returns what {@link #restore} needs to put things back. Null when
     * there is nothing to do (no id, or this thread is already tagged with it).
     */
    public static Object tag(String callId) {
        if (callId == null || callId.isEmpty()) {
            return null;
        }
        String previousId = CURRENT.get();
        if (callId.equals(previousId)) {
            return null;
        }
        Mdc[] mdcs = mdcs(Thread.currentThread().getContextClassLoader());
        Object[] previous = new Object[mdcs.length];
        boolean[] done = new boolean[mdcs.length];
        for (int i = 0; i < mdcs.length; i++) {
            try {
                previous[i] = mdcs[i].get.invoke(null, KEY);
                mdcs[i].put.invoke(null, KEY, callId);
                done[i] = true;
            } catch (Throwable t) {
                AgentLog.failure("log tagging (" + mdcs[i].name + ")", t);
            }
        }
        CURRENT.set(callId);
        return new Restore(mdcs, previous, done, previousId);
    }

    /** Puts back what {@link #tag} replaced, in reverse order (two MDCs may share one store). */
    public static void restore(Object token) {
        if (!(token instanceof Restore)) {
            return;
        }
        Restore r = (Restore) token;
        for (int i = r.mdcs.length - 1; i >= 0; i--) {
            if (!r.done[i]) {
                continue;
            }
            try {
                if (r.previous[i] == null) {
                    r.mdcs[i].remove.invoke(null, KEY);
                } else {
                    r.mdcs[i].put.invoke(null, KEY, r.previous[i]);
                }
            } catch (Throwable t) {
                AgentLog.failure("log untagging (" + r.mdcs[i].name + ")", t);
            }
        }
        if (r.previousId == null) {
            CURRENT.remove();
        } else {
            CURRENT.set(r.previousId);
        }
    }

    static Mdc[] mdcs(ClassLoader loader) {
        ClassLoader key = loader != null ? loader : ClassLoader.getSystemClassLoader();
        synchronized (BY_LOADER) {
            Mdc[] found = BY_LOADER.get(key);
            if (found == null) {
                found = probe(key);
                BY_LOADER.put(key, found);
            }
            return found;
        }
    }

    /** For tests: forget what was probed. */
    static void forget() {
        synchronized (BY_LOADER) {
            BY_LOADER.clear();
        }
    }

    private static Mdc[] probe(ClassLoader loader) {
        List<Mdc> out = new ArrayList<>();
        for (String name : MDC_CLASSES) {
            Class<?> c;
            try {
                c = Class.forName(name, true, loader);
            } catch (Throwable missing) {
                continue;
            }
            try {
                Method put = method(c, "put", String.class, String.class);
                if (put == null) {
                    put = method(c, "put", String.class, Object.class);
                }
                Method get = method(c, "get", String.class);
                Method remove = method(c, "remove", String.class);
                if (put != null && get != null && remove != null) {
                    out.add(new Mdc(name, put, get, remove));
                }
            } catch (Throwable t) {
                AgentLog.failure("log tagging probe (" + name + ")", t);
            }
        }
        return out.isEmpty() ? NONE : out.toArray(new Mdc[0]);
    }

    private static Method method(Class<?> c, String name, Class<?>... types) {
        try {
            Method m = c.getMethod(name, types);
            return java.lang.reflect.Modifier.isStatic(m.getModifiers()) ? m : null;
        } catch (NoSuchMethodException e) {
            return null;
        }
    }

    static final class Mdc {
        final String name;
        final Method put;
        final Method get;
        final Method remove;

        Mdc(String name, Method put, Method get, Method remove) {
            this.name = name;
            this.put = put;
            this.get = get;
            this.remove = remove;
        }
    }

    private static final class Restore {
        final Mdc[] mdcs;
        final Object[] previous;
        final boolean[] done;
        final String previousId;

        Restore(Mdc[] mdcs, Object[] previous, boolean[] done, String previousId) {
            this.mdcs = mdcs;
            this.previous = previous;
            this.done = done;
            this.previousId = previousId;
        }
    }
}
