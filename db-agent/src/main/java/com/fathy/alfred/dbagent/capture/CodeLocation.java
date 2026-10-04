package com.fathy.alfred.dbagent.capture;

/**
 * "Where in code": the first stack frame that belongs to the application - skipping the JDK, JDBC drivers, connection
 * pools, ORMs and the agent itself - as {@code Class.method(File.java:line)}.
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

    private CodeLocation() {
    }

    static String find() {
        StackTraceElement[] stack = new Throwable().getStackTrace();
        for (StackTraceElement frame : stack) {
            String cls = frame.getClassName();
            if (!skipped(cls) && !cls.contains("$$")) {
                String simple = cls.substring(cls.lastIndexOf('.') + 1);
                return simple + "." + frame.getMethodName() + "(" + frame.getFileName() + ":" + frame.getLineNumber() + ")";
            }
        }
        return null;
    }

    private static boolean skipped(String cls) {
        for (String prefix : SKIP) {
            if (cls.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }
}
