package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.transport.PassThrough;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.function.Function;
import java.util.stream.Stream;

/**
 * "Where in code": the first stack frame that belongs to the application - skipping the JDK, JDBC drivers, connection
 * pools, ORMs and the agent itself - as {@code Class.method(File.java:line)}, and the application's CALL CHAIN: up to N
 * application frames past the project's pass-through classes. A generic DAO every query goes through
 * ({@code GenericDAOImpl.fetchWithSlaveHQL} ×757 in one real capture) says nothing about who asked; the services above
 * it do.
 *
 * <p>Walking the stack is the costliest thing the agent does per statement, so it walks lazily: on Java 9+ through
 * {@code StackWalker} (frames are materialised one at a time and the walk stops as soon as the chain is complete), on
 * Java 8 through the JDK's own per-index accessor, so only the frames looked at become StackTraceElements. Both are
 * reached reflectively - the agent is compiled for Java 8 - and fall back to {@code Throwable.getStackTrace()}.
 */
final class CodeLocation {

    private static final String[] SKIP = {
            "java.", "javax.", "jakarta.", "sun.", "jdk.", "com.sun.", "net.bytebuddy.", "com.fathy.alfred.dbagent.capture.",
            "com.fathy.alfred.dbagent.advice.", "com.fathy.alfred.dbagent.bootstrap.", "com.fathy.alfred.dbagent.shaded.",
            "org.hibernate.", "org.springframework.jdbc.", "org.springframework.orm.", "org.springframework.transaction.",
            "org.springframework.aop.", "org.springframework.cglib.", "org.jboss.jca.", "org.jboss.as.", "org.jboss.resource.",
            "org.jboss.weld.", "org.jboss.invocation.", "org.jboss.ejb", "io.agroal.", "com.zaxxer.", "org.apache.commons.dbcp",
            "org.apache.tomcat.jdbc.", "com.mchange.", "org.mybatis.", "org.apache.ibatis.", "org.jooq.", "org.eclipse.persistence.",
            "oracle.", "org.postgresql.", "com.mysql.", "org.mariadb.", "com.microsoft.sqlserver.", "org.h2.", "org.hsqldb.",
            "com.ibm.db2.", "org.junit.", "org.apache.maven.", "jdk.internal.",
            // Redis clients and what is built on them (specs/011-redis-capture): the code line is the application's
            "io.lettuce.", "redis.clients.", "org.redisson.", "io.netty.", "reactor.", "org.springframework.data.redis.",
            "org.springframework.cache.", "org.apache.commons.pool2.", "com.fathy.alfred.dbagent.redis."
    };

    /** Per class name: an application frame or not. A stack is mostly the same few hundred classes, and the prefix
     *  scan was the walk's main cost. Bounded - cleared when it outgrows the limit. Declared
     *  before WALKER: creating the walker already walks once. */
    private static final java.util.concurrent.ConcurrentHashMap<String, Boolean> SKIPPED = new java.util.concurrent.ConcurrentHashMap<>();
    private static final int CACHE_LIMIT = 8192;

    /** Whether the last {@link #find} on this thread walked past a Hibernate frame - SQL Hibernate made on its own
     *  (an id from a sequence, a version check) outside any query or event the agent tracks. */
    private static final ThreadLocal<boolean[]> SAW_HIBERNATE = ThreadLocal.withInitial(() -> new boolean[1]);

    private static final Walker WALKER = Walker.create();

    private CodeLocation() {
    }

    /** One walk's answer: the first application frame, and the call chain (null when none was asked for or found). */
    static final class Where {
        final String location;
        final List<String> callers;

        Where(String location, List<String> callers) {
            this.location = location;
            this.callers = callers;
        }
    }

    /** Receives frames innermost first; returns false to stop the walk. */
    interface Collector {
        boolean accept(String cls, String method, String file, int line);
    }

    /** The first application frame and up to {@code frames} application frames past {@code passThrough}. */
    static Where find(int frames, PassThrough passThrough) {
        SAW_HIBERNATE.get()[0] = false;
        ChainCollector chain = new ChainCollector(frames, passThrough);
        try {
            WALKER.walk(chain);
        } catch (Throwable t) {
            chain = new ChainCollector(frames, passThrough);
            for (StackTraceElement frame : new Throwable().getStackTrace()) {
                if (!chain.accept(frame.getClassName(), frame.getMethodName(), frame.getFileName(), frame.getLineNumber())) {
                    break;
                }
            }
        }
        return new Where(chain.first, chain.callers);
    }

    /** Just the first application frame. */
    static String find() {
        return find(0, PassThrough.NONE).location;
    }

    private static final class ChainCollector implements Collector {
        private final int frames;
        private final PassThrough passThrough;
        String first;
        List<String> callers;

        ChainCollector(int frames, PassThrough passThrough) {
            this.frames = frames;
            this.passThrough = passThrough;
        }

        @Override
        public boolean accept(String cls, String method, String file, int line) {
            if (skipped(cls)) {
                if (first == null) {
                    passed(cls); // only Hibernate frames BELOW the code that ran the statement make it Hibernate's own SQL
                }
                return true;
            }
            String location = cls.substring(cls.lastIndexOf('.') + 1) + "." + method + "(" + file + ":" + line + ")";
            if (first == null) {
                first = location;
            }
            if (frames <= 0) {
                return false;
            }
            if (passThrough.matches(cls)) {
                return true;
            }
            if (callers == null) {
                callers = new ArrayList<>(frames);
            }
            if (callers.isEmpty() || !callers.get(callers.size() - 1).equals(location)) {
                callers.add(location); // a recursive frame twice in a row says nothing new
            }
            return callers.size() < frames;
        }
    }

    static boolean sawHibernate() {
        return SAW_HIBERNATE.get()[0];
    }

    private static void passed(String cls) {
        if (cls.startsWith("org.hibernate.")) {
            SAW_HIBERNATE.get()[0] = true;
        }
    }

    /** The location string when this frame belongs to the application, else null. */
    static String format(String cls, String method, String file, int line) {
        if (skipped(cls)) {
            passed(cls);
            return null;
        }
        return cls.substring(cls.lastIndexOf('.') + 1) + "." + method + "(" + file + ":" + line + ")";
    }

    private static boolean skipped(String cls) {
        Boolean known = SKIPPED.get(cls);
        if (known != null) {
            return known;
        }
        boolean skip = cls.contains("$$");
        for (int i = 0; !skip && i < SKIP.length; i++) {
            skip = cls.startsWith(SKIP[i]);
        }
        if (SKIPPED.size() >= CACHE_LIMIT) {
            SKIPPED.clear();
        }
        SKIPPED.put(cls, skip);
        return skip;
    }

    private abstract static class Walker {
        abstract void walk(Collector collector) throws Exception;

        static Walker create() {
            try {
                return new StackWalkerWalker();
            } catch (Throwable java8) {
                try {
                    return new JavaLangAccessWalker();
                } catch (Throwable none) {
                    return new Walker() {
                        @Override
                        void walk(Collector collector) {
                            for (StackTraceElement frame : new Throwable().getStackTrace()) {
                                if (!collector.accept(frame.getClassName(), frame.getMethodName(), frame.getFileName(), frame.getLineNumber())) {
                                    return;
                                }
                            }
                        }
                    };
                }
            }
        }
    }

    /** Java 9+: {@code StackWalker.getInstance().walk(stream -> ...)}, stopping when the collector has enough. */
    private static final class StackWalkerWalker extends Walker {
        private final Object walker;
        private final Method walk;
        private final Method className;
        private final Method methodName;
        private final Method fileName;
        private final Method lineNumber;

        StackWalkerWalker() throws Exception {
            Class<?> walkerClass = Class.forName("java.lang.StackWalker");
            Class<?> frame = Class.forName("java.lang.StackWalker$StackFrame");
            walker = walkerClass.getMethod("getInstance").invoke(null);
            walk = walkerClass.getMethod("walk", Function.class);
            className = frame.getMethod("getClassName");
            methodName = frame.getMethod("getMethodName");
            fileName = frame.getMethod("getFileName");
            lineNumber = frame.getMethod("getLineNumber");
            walk((cls, method, file, line) -> false); // fail now, not per statement, if anything here does not work
        }

        @Override
        void walk(Collector collector) throws Exception {
            Function<Stream<?>, Object> walking = frames -> {
                try {
                    Iterator<?> it = frames.iterator();
                    while (it.hasNext()) {
                        Object frame = it.next();
                        if (!collector.accept((String) className.invoke(frame), (String) methodName.invoke(frame),
                                (String) fileName.invoke(frame), (Integer) lineNumber.invoke(frame))) {
                            break;
                        }
                    }
                    return null;
                } catch (Exception e) {
                    throw new IllegalStateException(e);
                }
            };
            walk.invoke(walker, walking);
        }
    }

    /** Java 8: {@code SharedSecrets.getJavaLangAccess().getStackTraceElement(throwable, i)} - one element at a time. */
    private static final class JavaLangAccessWalker extends Walker {
        private final Object access;
        private final Method depth;
        private final Method element;

        JavaLangAccessWalker() throws Exception {
            Object secrets = Class.forName("sun.misc.SharedSecrets").getMethod("getJavaLangAccess").invoke(null);
            Class<?> accessClass = Class.forName("sun.misc.JavaLangAccess");
            access = secrets;
            depth = accessClass.getMethod("getStackTraceDepth", Throwable.class);
            element = accessClass.getMethod("getStackTraceElement", Throwable.class, int.class);
            walk((cls, method, file, line) -> false);
        }

        @Override
        void walk(Collector collector) throws Exception {
            Throwable t = new Throwable();
            int n = (Integer) depth.invoke(access, t);
            for (int i = 0; i < n; i++) {
                StackTraceElement frame = (StackTraceElement) element.invoke(access, t, i);
                if (!collector.accept(frame.getClassName(), frame.getMethodName(), frame.getFileName(), frame.getLineNumber())) {
                    return;
                }
            }
        }
    }
}
