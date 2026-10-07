package com.fathy.alfred.dbagent;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.instrument.Instrumentation;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.JarOutputStream;

/**
 * ALFRED's agent (docs/db-capture.md). Loaded into the application's JVM at startup
 * ({@code -javaagent:alfred-agent.jar=<args>}) or into a running one through the Attach API ({@code alfred attach},
 * {@code wildfly-proxy-toggle/db-capture-on}), it records every JDBC statement the application runs, tied to the
 * inbound call that caused it, and ships it to ALFRED. It never changes what the application does: everything it adds
 * is recording, and every failure inside it is swallowed. The one exception is the "proxy" feature, whose purpose is
 * routing the application's outbound calls through Alfred (and trusting Alfred's CA for them).
 *
 * <p>This class deliberately mentions nothing but JDK types. The {@code bootstrap} package (Bridge) must reach the
 * bootstrap class path BEFORE any agent class that implements or uses it is loaded: verifying a class that passes a
 * CaptureDispatcher where a Bridge.Dispatcher is expected loads Bridge.Dispatcher, and if that happens first through
 * the application loader there are two incompatible Bridges and every instrumented JDK class fails to link (found by
 * the tests, and exactly what a production attach would have hit). So: inject, then start {@link AgentRuntime}
 * reflectively.
 */
public final class AlfredDbAgent {

    public static final String VERSION = "1.0.0";
    private AlfredDbAgent() {
    }

    public static void premain(String args, Instrumentation instrumentation) {
        start(args, instrumentation);
    }

    public static void agentmain(String args, Instrumentation instrumentation) {
        start(args, instrumentation);
    }

    /** Every load applies its arguments: a second attach changes the features, it does not start a second agent. */
    private static synchronized void start(String args, Instrumentation instrumentation) {
        try {
            injectBootstrap(instrumentation);
            Class.forName("com.fathy.alfred.dbagent.AgentRuntime", true, AlfredDbAgent.class.getClassLoader())
                    .getMethod("apply", String.class, Instrumentation.class)
                    .invoke(null, args, instrumentation);
        } catch (Throwable t) {
            AgentLog.info("could not start (" + t + ") - the application continues without Alfred");
        }
    }

    /**
     * Puts the bootstrap package (Bridge and its Dispatcher interface) on the bootstrap class path from a temp jar
     * written out of this agent's own jar. Idempotent per JVM: a second call finds the class already there.
     */
    public static void injectBootstrap(Instrumentation instrumentation) throws IOException {
        if (bootstrapPresent()) {
            return;
        }
        File jar = File.createTempFile("alfred-agent-bootstrap-", ".jar");
        jar.deleteOnExit();
        String[] classes = {"com/fathy/alfred/dbagent/bootstrap/Bridge.class", "com/fathy/alfred/dbagent/bootstrap/Bridge$Dispatcher.class",
                "com/fathy/alfred/dbagent/bootstrap/TrustBridge.class"};
        try (JarOutputStream out = new JarOutputStream(new FileOutputStream(jar))) {
            for (String name : classes) {
                try (InputStream in = AlfredDbAgent.class.getClassLoader().getResourceAsStream(name)) {
                    if (in == null) {
                        throw new IOException("missing " + name + " in the agent jar");
                    }
                    out.putNextEntry(new JarEntry(name));
                    byte[] buffer = new byte[8192];
                    int n;
                    while ((n = in.read(buffer)) > 0) {
                        out.write(buffer, 0, n);
                    }
                    out.closeEntry();
                }
            }
        }
        instrumentation.appendToBootstrapClassLoaderSearch(new JarFile(jar));
    }

    private static boolean bootstrapPresent() {
        try {
            Class.forName("com.fathy.alfred.dbagent.bootstrap.Bridge", false, null);
            return true;
        } catch (ClassNotFoundException e) {
            return false;
        }
    }
}
