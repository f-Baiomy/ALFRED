package com.fathy.alfred.attach;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Properties;
import java.util.jar.Attributes;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import java.util.jar.Manifest;

import static org.assertj.core.api.Assertions.assertThat;

/** A real child JVM: listed by "jvms", "attach" sends the feature set and confirms it, "detach" takes features away. */
class AttachCliIT {

    private static Process child;
    private static String pid;
    private static Path agentJar;

    private ByteArrayOutputStream out;
    private ByteArrayOutputStream err;

    @BeforeAll
    static void start() throws Exception {
        child = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-cp", System.getProperty("java.class.path"), Sleeper.class.getName()).redirectErrorStream(true).start();
        assertThat(new String(child.getInputStream().readNBytes(5), StandardCharsets.UTF_8)).isEqualTo("ready");
        pid = String.valueOf(child.pid());
        agentJar = Files.createTempFile("test-agent", ".jar");
        Manifest manifest = new Manifest();
        manifest.getMainAttributes().put(Attributes.Name.MANIFEST_VERSION, "1.0");
        manifest.getMainAttributes().putValue("Agent-Class", TestAgent.class.getName());
        String entry = TestAgent.class.getName().replace('.', '/') + ".class";
        try (OutputStream file = Files.newOutputStream(agentJar); JarOutputStream jar = new JarOutputStream(file, manifest);
             InputStream in = TestAgent.class.getClassLoader().getResourceAsStream(entry)) {
            jar.putNextEntry(new JarEntry(entry));
            in.transferTo(jar);
        }
    }

    @AfterAll
    static void stop() {
        child.destroyForcibly();
    }

    private int run(Map<String, String> env, String... args) {
        out = new ByteArrayOutputStream();
        err = new ByteArrayOutputStream();
        return new AttachCli(new PrintStream(out, true, StandardCharsets.UTF_8), new PrintStream(err, true, StandardCharsets.UTF_8), env).run(args);
    }

    private static Properties props() throws Exception {
        com.sun.tools.attach.VirtualMachine vm = com.sun.tools.attach.VirtualMachine.attach(pid);
        try {
            return vm.getSystemProperties();
        } finally {
            vm.detach();
        }
    }

    @Test
    void listsAttachesAndDetaches() throws Exception {
        assertThat(run(Map.of(), "jvms", "--json")).isZero();
        assertThat(out.toString(StandardCharsets.UTF_8)).contains("\"pid\":\"" + pid + "\"").contains(Sleeper.class.getName());

        String base = "alfredUrl=http://127.0.0.1:3000;project=demo;proxy=127.0.0.2:443;features=ignored";
        String pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
        assertThat(run(Map.of("ALFRED_AGENT_SECRET", "s3cret", "ALFRED_AGENT_CA", pem),
                "attach", pid, "--agent", agentJar.toString(), "--args", base)).as(() -> err.toString()).isZero();
        assertThat(out.toString(StandardCharsets.UTF_8)).contains("Alfred proxy");
        String args = props().getProperty("alfred.test.args");
        assertThat(args).startsWith("alfredUrl=http://127.0.0.1:3000;project=demo;proxy=127.0.0.2:443;features=proxy;secret=s3cret;caFile=")
                .doesNotContain("ignored");
        assertThat(Files.readString(Path.of(args.substring(args.indexOf("caFile=") + 7)))).isEqualTo(pem);

        assertThat(run(Map.of(), "attach", pid, "--agent", agentJar.toString(), "--args", base, "--add", "redis,db")).isZero();
        assertThat(props().getProperty(AttachCli.FEATURES)).isEqualTo("proxy,db,redis");

        assertThat(run(Map.of(), "detach", pid, "--agent", agentJar.toString(), "--args", base, "--remove", "proxy")).isZero();
        assertThat(props().getProperty(AttachCli.FEATURES)).isEqualTo("db,redis");
        assertThat(run(Map.of(), "detach", pid, "--agent", agentJar.toString(), "--args", base)).isZero();
        assertThat(props().getProperty(AttachCli.FEATURES)).isEmpty();

        assertThat(run(Map.of(), "jvms")).isZero();
        assertThat(out.toString(StandardCharsets.UTF_8)).contains(pid).contains("loaded, off");
        assertThat(run(Map.of(), "attach", pid, "--agent", agentJar.toString(), "--add", "teleport")).isEqualTo(AttachCli.USAGE);
    }
}
