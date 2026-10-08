package com.fathy.alfred.dbagent;

import com.sun.net.httpserver.HttpServer;
import net.bytebuddy.ByteBuddy;
import org.example.lateattach.LateApp;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.jar.Attributes;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import java.util.jar.Manifest;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * "No matter what started before what, nothing is restarted" - the production path end to end: a separate JVM (an
 * application running for a while, driver and servlet classes long loaded), the real agent jar loaded through the
 * Attach API like the supervisor does, the real HTTP sender reporting to a stand-in Alfred. Then Alfred "updates":
 * a new agent build is attached from another copy (the supervisor's agents/alfred-agent-<digest>.jar) into the JVM
 * that already runs the old one - capture must go on, with no agent failure in the application's console.
 */
class LateAttachIT {

    private final List<String> batches = new CopyOnWriteArrayList<>();
    private final StringBuffer console = new StringBuffer();
    private HttpServer alfred;
    private Process app;
    private Path work;

    @BeforeEach
    void start() throws Exception {
        work = Files.createTempDirectory("late-attach-");
        alfred = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        alfred.createContext("/", exchange -> {
            String body = read(exchange.getRequestBody());
            if (exchange.getRequestURI().getPath().endsWith("/batch")) {
                batches.add(body);
            }
            byte[] answer = "{\"rowsPerResult\":50000,\"beforeImageTables\":[],\"ignorePatterns\":[],\"outsideCallCapture\":false,\"captureEnabled\":true}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        alfred.start();
    }

    @AfterEach
    void stop() throws Exception {
        if (app != null) {
            app.getOutputStream().close();
            if (!app.waitFor(10, TimeUnit.SECONDS)) {
                app.destroyForcibly();
            }
        }
        alfred.stop(0);
        deleteTree(work);
    }

    @Test
    void anAgentAttachedLongAfterTheAppStartedCapturesItsNextCalls_andANewerBuildAttachedLaterKeepsItCapturing() throws Exception {
        app = startApp();
        Thread.sleep(1500); // the app's calls run without any agent: every class they need is loaded

        Path first = agentJar(work.resolve("agents-1"), "build-1");
        load(first, "db");
        int afterFirst = waitForCapturedCall(0);
        assertThat(afterFirst).as("a call made after the late attach is captured").isPositive();

        // Alfred is updated while the app keeps running: the supervisor attaches the new build from a new copy
        Path second = agentJar(work.resolve("agents-2"), "build-2");
        load(second, "db");
        int afterSecond = waitForCapturedCall(afterFirst);
        assertThat(afterSecond).as("capture goes on after the newer build was attached").isGreaterThan(afterFirst);

        // turned off and on again through re-attaches, still without a restart
        load(second, "");
        Thread.sleep(600);
        load(second, "db");
        assertThat(waitForCapturedCall(afterSecond)).isGreaterThan(afterSecond);

        assertThat(console.toString()).doesNotContain("failed:").doesNotContain("NoClassDefFoundError").doesNotContain("could not start");
    }

    @Test
    void anAgentAttachedTheMomentTheAppIsUpCapturesFromItsFirstCalls() throws Exception {
        app = startApp();
        load(agentJar(work.resolve("agents"), "build-1"), "db");
        assertThat(waitForCapturedCall(0)).isPositive();
        assertThat(console.toString()).doesNotContain("failed:").doesNotContain("NoClassDefFoundError");
    }

    /** The highest call number above {@code after} that has a captured statement, waiting up to 15 s for one. */
    private int waitForCapturedCall(int after) throws InterruptedException {
        Pattern call = Pattern.compile("late-call-(\\d+)");
        long deadline = System.currentTimeMillis() + 15_000;
        while (System.currentTimeMillis() < deadline) {
            int best = 0;
            for (String batch : batches) {
                if (!batch.contains("SELECT COUNT(*) FROM LATE_T")) {
                    continue;
                }
                Matcher m = call.matcher(batch);
                while (m.find()) {
                    best = Math.max(best, Integer.parseInt(m.group(1)));
                }
            }
            if (best > after) {
                return best;
            }
            Thread.sleep(200);
        }
        throw new AssertionError("no statement captured for a call after late-call-" + after + "\n--- app console ---\n" + console);
    }

    private Process startApp() throws Exception {
        String agentClasses = codeSource(AlfredDbAgent.class);
        String classPath = java.util.Arrays.stream(System.getProperty("java.class.path").split(File.pathSeparator))
                .filter(entry -> !samePath(entry, agentClasses))
                .collect(Collectors.joining(File.pathSeparator));
        List<String> command = new ArrayList<>();
        command.add(System.getProperty("java.home") + File.separator + "bin" + File.separator + "java");
        command.add("-cp");
        command.add(classPath);
        command.add(LateApp.class.getName());
        ProcessBuilder builder = new ProcessBuilder(command).redirectErrorStream(true);
        builder.environment().put("ALFRED_AGENT_SECRET", "late-secret");
        Process process = builder.start();
        BufferedReader out = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
        String line = out.readLine();
        assertThat(line).as("the app started").isEqualTo("READY");
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

    /** VirtualMachine.attach(pid).loadAgent(jar, args), by reflection: this module compiles for Java 8. */
    private void load(Path jar, String features) throws Exception {
        Class<?> vmClass = Class.forName("com.sun.tools.attach.VirtualMachine");
        Object vm = vmClass.getMethod("attach", String.class).invoke(null, String.valueOf(pid(app)));
        try {
            String args = "alfredUrl=http://127.0.0.1:" + alfred.getAddress().getPort() + ";project=late;secret=late-secret;features=" + features;
            vmClass.getMethod("loadAgent", String.class, String.class).invoke(vm, jar.toString(), args);
        } finally {
            vmClass.getMethod("detach").invoke(vm);
        }
    }

    private static long pid(Process process) throws Exception {
        return (Long) Process.class.getMethod("pid").invoke(process); // Java 9+, like the attach itself
    }

    /**
     * An agent jar as the release builds it, from this build's classes: Agent-Class and retransformation in the
     * manifest, ByteBuddy through Class-Path (the release shades it in). {@code build} makes two builds' bytes differ.
     */
    private static Path agentJar(Path folder, String build) throws Exception {
        Files.createDirectories(folder);
        Path jar = folder.resolve("alfred-agent.jar");
        Manifest manifest = new Manifest();
        Attributes main = manifest.getMainAttributes();
        main.put(Attributes.Name.MANIFEST_VERSION, "1.0");
        main.putValue("Agent-Class", AlfredDbAgent.class.getName());
        main.putValue("Premain-Class", AlfredDbAgent.class.getName());
        main.putValue("Can-Retransform-Classes", "true");
        main.putValue("Can-Redefine-Classes", "true");
        main.put(Attributes.Name.CLASS_PATH, new File(codeSource(ByteBuddy.class)).toURI().toString());
        Path classes = Paths.get(codeSource(AlfredDbAgent.class));
        try (JarOutputStream out = new JarOutputStream(Files.newOutputStream(jar), manifest)) {
            out.putNextEntry(new JarEntry("BUILD"));
            out.write(build.getBytes(StandardCharsets.UTF_8));
            out.closeEntry();
            List<Path> files;
            try (java.util.stream.Stream<Path> walk = Files.walk(classes)) {
                files = walk.filter(Files::isRegularFile).collect(Collectors.toList());
            }
            for (Path file : files) {
                out.putNextEntry(new JarEntry(classes.relativize(file).toString().replace('\\', '/')));
                out.write(Files.readAllBytes(file));
                out.closeEntry();
            }
        }
        return jar;
    }

    private static String codeSource(Class<?> type) throws Exception {
        return new File(type.getProtectionDomain().getCodeSource().getLocation().toURI()).getPath();
    }

    private static boolean samePath(String a, String b) {
        try {
            return new File(a).getCanonicalPath().equals(new File(b).getCanonicalPath());
        } catch (Exception e) {
            return false;
        }
    }

    private static String read(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) > 0) {
            out.write(buffer, 0, n);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void deleteTree(Path root) throws java.io.IOException {
        if (root == null || !Files.exists(root)) {
            return;
        }
        Files.walkFileTree(root, new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                file.toFile().delete(); // a jar the app still holds open on Windows stays: it is a temp folder
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path dir, java.io.IOException e) {
                dir.toFile().delete();
                return FileVisitResult.CONTINUE;
            }
        });
    }
}
