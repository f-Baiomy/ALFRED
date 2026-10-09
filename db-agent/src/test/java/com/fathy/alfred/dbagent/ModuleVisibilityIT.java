package com.fathy.alfred.dbagent;

import org.jboss.modules.Module;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 2026-10-09: attached to a running WildFly, the agent printed "instrumented -260 of 105 already-loaded classes" and
 * left log4j 1.2's Category and c3p0's NewProxy* without capture (VerifyError). Those class files predate Java 6, so
 * retransforming them runs the JVM's old verifier, which loads every type the inlined advice names - the bootstrap
 * Bridge - through the class's own loader: a JBoss deployment module, which cannot see it until JBoss Modules' Module
 * is advised. The agent now advises Module first, alone. Here a separate JVM loads log4j 1.2.17 through a stand-in
 * module, then the real agent jar is attached the way the supervisor does.
 */
class ModuleVisibilityIT {

    private final StringBuffer console = new StringBuffer();
    private Process app;
    private Path work;

    @AfterEach
    void stop() throws Exception {
        if (app != null) {
            app.getOutputStream().close();
            if (!app.waitFor(10, TimeUnit.SECONDS)) {
                app.destroyForcibly();
            }
        }
        if (work != null) {
            try (java.util.stream.Stream<Path> walk = Files.walk(work)) {
                walk.sorted(java.util.Comparator.reverseOrder()).map(Path::toFile).forEach(File::delete);
            }
        }
    }

    @Test
    void aPreJava6ClassInAJBossModuleGetsItsAdviceOnALateAttach() throws Exception {
        work = Files.createTempDirectory("module-visibility-");
        Path log4j = new File("target/legacy-log4j/log4j-1.2.17.jar").toPath().toAbsolutePath();
        assertThat(log4j).exists();
        app = startApp(log4j);

        Path jar = LateAttachIT.agentJar(work.resolve("agents"), "build-1");
        Class<?> vmClass = Class.forName("com.sun.tools.attach.VirtualMachine");
        Object vm = vmClass.getMethod("attach", String.class).invoke(null, String.valueOf((Long) Process.class.getMethod("pid").invoke(app)));
        try {
            vmClass.getMethod("loadAgent", String.class, String.class)
                    .invoke(vm, jar.toString(), "alfredUrl=http://127.0.0.1:1;project=modules;secret=s;features=db,logs");
        } finally {
            vmClass.getMethod("detach").invoke(vm);
        }
        long deadline = System.currentTimeMillis() + 15_000;
        while (!console.toString().contains("features: ") && System.currentTimeMillis() < deadline) {
            Thread.sleep(100);
        }
        assertThat(console.toString()).contains("features: db,logs")
                .doesNotContain("VerifyError").doesNotContain("not instrumented");
    }

    private Process startApp(Path log4j) throws Exception {
        String agentClasses = LateAttachIT.codeSource(AlfredDbAgent.class);
        String classPath = java.util.Arrays.stream(System.getProperty("java.class.path").split(File.pathSeparator))
                .filter(entry -> !LateAttachIT.samePath(entry, agentClasses))
                .collect(Collectors.joining(File.pathSeparator));
        List<String> command = new ArrayList<>();
        command.add(System.getProperty("java.home") + File.separator + "bin" + File.separator + "java");
        command.add("-cp");
        command.add(classPath);
        command.add(ModuleApp.class.getName());
        command.add(log4j.toString());
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        BufferedReader out = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
        String line;
        while ((line = out.readLine()) != null && !line.equals("READY")) {
            console.append(line).append('\n');
        }
        assertThat(line).as("the app started\n" + console).isEqualTo("READY");
        Thread reader = new Thread(() -> {
            try {
                String l;
                while ((l = out.readLine()) != null) {
                    console.append(l).append('\n');
                }
            } catch (Exception ignored) {
                // the app ended
            }
        });
        reader.setDaemon(true);
        reader.start();
        return process;
    }

    /** The app: log4j 1.2's Category loaded and used through a JBoss-style module loader, then waits for stdin to close. */
    public static final class ModuleApp {

        public static void main(String[] args) throws Exception {
            ModuleLoader loader = new ModuleLoader(new URL[]{new File(args[0]).toURI().toURL()});
            Class<?> category = Class.forName("org.apache.log4j.Category", true, loader);
            category.getMethod("getInstance", String.class).invoke(null, "module-visibility");
            System.out.println("READY");
            System.out.flush();
            while (System.in.read() >= 0) {
                // until the test closes stdin
            }
        }
    }

    /** A deployment's class loader: every class but java.* comes through its Module, as in JBoss Modules. */
    static final class ModuleLoader extends URLClassLoader {

        private final Module module;

        ModuleLoader(URL[] urls) {
            super(urls, null);
            ModuleLoader self = this;
            module = new Module(new ClassLoader(null) {
                @Override
                protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
                    try {
                        return Class.forName(name, false, null);
                    } catch (ClassNotFoundException e) {
                        return self.own(name);
                    }
                }
            });
        }

        @Override
        protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
            if (name.startsWith("java.")) {
                return super.loadClass(name, resolve);
            }
            return module.loadModuleClass(name, resolve);
        }

        Class<?> own(String name) throws ClassNotFoundException {
            synchronized (getClassLoadingLock(name)) {
                Class<?> loaded = findLoadedClass(name);
                return loaded != null ? loaded : findClass(name);
            }
        }
    }
}
