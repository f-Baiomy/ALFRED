package com.fathy.alfred.dbagent.capture;

import java.lang.reflect.Method;
import java.util.Iterator;
import java.util.function.Function;
import java.util.stream.Stream;

/**
 * "Where in code": the first stack frame that belongs to the application - skipping the JDK, JDBC drivers, connection
 * pools, ORMs and the agent itself - as {@code Class.method(File.java:line)}.
 *
 * <p>Walking the stack is the costliest thing the agent does per statement, so it walks lazily: on Java 9+ through
 * {@code StackWalker} (frames are materialised one at a time and the walk stops at the first application frame), on
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
            "com.ibm.db2.", "org.junit.", "org.apache.maven.", "jdk.internal."
    };

    private static final Walker WALKER = Walker.create();

    private CodeLocation() {
    }

    static String find() {
        try {
            return WALKER.find();
        } catch (Throwable t) {
            return fromThrowable();
        }
    }

    static String fromThrowable() {
        for (StackTraceElement frame : new Throwable().getStackTrace()) {
            String location = format(frame.getClassName(), frame.getMethodName(), frame.getFileName(), frame.getLineNumber());
            if (location != null) {
                return location;
            }
        }
        return null;
    }

    /** The location string when this frame belongs to the application, else null. */
    static String format(String cls, String method, String file, int line) {
        if (skipped(cls) || cls.contains("$$")) {
            return null;
        }
        return cls.substring(cls.lastIndexOf('.') + 1) + "." + method + "(" + file + ":" + line + ")";
    }

    private static boolean skipped(String cls) {
        for (String prefix : SKIP) {
            if (cls.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    private abstract static class Walker {
        abstract String find() throws Exception;

        static Walker create() {
            try {
                return new StackWalkerWalker();
            } catch (Throwable java8) {
                try {
                    return new JavaLangAccessWalker();
                } catch (Throwable none) {
                    return new Walker() {
                        @Override
                        String find() {
                            return fromThrowable();
                        }
                    };
                }
            }
        }
    }

    /** Java 9+: {@code StackWalker.getInstance().walk(stream -> first application frame)}. */
    private static final class StackWalkerWalker extends Walker implements Function<Stream<?>, String> {
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
            find(); // fail now, not per statement, if anything here does not work
        }

        @Override
        String find() throws Exception {
            return (String) walk.invoke(walker, this);
        }

        @Override
        public String apply(Stream<?> frames) {
            try {
                Iterator<?> it = frames.iterator();
                while (it.hasNext()) {
                    Object frame = it.next();
                    String cls = (String) className.invoke(frame);
                    if (skipped(cls) || cls.contains("$$")) {
                        continue;
                    }
                    return format(cls, (String) methodName.invoke(frame), (String) fileName.invoke(frame), (Integer) lineNumber.invoke(frame));
                }
                return null;
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
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
            find();
        }

        @Override
        String find() throws Exception {
            Throwable t = new Throwable();
            int n = (Integer) depth.invoke(access, t);
            for (int i = 0; i < n; i++) {
                StackTraceElement frame = (StackTraceElement) element.invoke(access, t, i);
                String location = format(frame.getClassName(), frame.getMethodName(), frame.getFileName(), frame.getLineNumber());
                if (location != null) {
                    return location;
                }
            }
            return null;
        }
    }
}
