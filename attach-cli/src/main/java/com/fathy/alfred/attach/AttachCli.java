package com.fathy.alfred.attach;

import com.sun.tools.attach.AgentLoadException;
import com.sun.tools.attach.VirtualMachine;
import com.sun.tools.attach.VirtualMachineDescriptor;

import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Properties;
import java.util.Set;

/**
 * "alfred jvms / attach / detach" (specs/012-server-program contracts/cli.md, research R12/R16), run on the bundled
 * JDK 21 by packaging/launcher/attach_cli.py.
 *
 * <pre>
 *   java -jar attach-cli.jar jvms [--json]
 *   java -jar attach-cli.jar info PID [--json]
 *   java -jar attach-cli.jar attach PID --agent JAR --args BASE_ARGS [--add proxy,db,logs,redis]
 *   java -jar attach-cli.jar detach PID --agent JAR --args BASE_ARGS [--remove proxy,db,logs,redis]
 * </pre>
 * The agent's whole feature set is sent on every load ({@code features=}), so attach adds to what the JVM has and
 * detach takes away; the result is confirmed by the {@code alfred.agent.features} property the agent publishes. The
 * webhook secret and Alfred's CA come in the environment ({@code ALFRED_AGENT_SECRET}, {@code ALFRED_AGENT_CA}), never
 * on a command line, so they can reach an app that cannot read the install folder.
 *
 * <p>Two rules from spike S2: a JDK 8 target answers a successful load with a reply a JDK 9+ client reports as
 * {@code AgentLoadException: ...0} - that one is success, confirmed by the property; and a JVM owned by another user is
 * never attached directly (a failed cross-user attach makes the target dump every thread to its console) - the
 * launcher re-runs this as the owner.
 */
public final class AttachCli {

    static final int OK = 0;
    static final int ERROR = 1;
    static final int USAGE = 2;
    static final int NOT_ALLOWED = 5;

    static final String FEATURES = "alfred.agent.features";
    /** Set by the agent while Alfred is unreachable and everything it switched on is off (AgentRuntime.standDown). */
    static final String STANDBY = "alfred.agent.standby";
    /** The Alfred the agent reports to now (AgentRuntime) - it follows the reverse proxy, so not always its arguments. */
    static final String AGENT_URL = "alfred.agent.url";
    static final String VERSION = "alfred.agent.version";
    static final List<String> ALL_FEATURES = List.of("proxy", "db", "logs", "redis");

    private final PrintStream out;
    private final PrintStream err;
    private final Map<String, String> env;

    AttachCli(PrintStream out, PrintStream err, Map<String, String> env) {
        this.out = out;
        this.err = err;
        this.env = env;
    }

    public static void main(String[] args) {
        System.exit(new AttachCli(System.out, System.err, System.getenv()).run(args));
    }

    int run(String[] args) {
        List<String> rest = Arrays.asList(args);
        if (rest.isEmpty()) {
            return usage();
        }
        boolean json = rest.contains("--json");
        try {
            return switch (rest.get(0)) {
                case "jvms" -> jvms(json);
                case "info" -> rest.size() >= 2 ? info(rest.get(1), json) : usage();
                case "attach", "detach" -> rest.size() >= 2 ? load(rest.get(0).equals("attach"), rest.get(1), rest.subList(2, rest.size())) : usage();
                default -> usage();
            };
        } catch (NotAllowed e) {
            err.println(e.getMessage());
            return NOT_ALLOWED;
        } catch (IllegalArgumentException e) {
            err.println("error: " + e.getMessage());
            return USAGE;
        } catch (Exception e) {
            // The class too: an attach failure without a message (an IOException from the target JVM, a
            // NullPointerException) would otherwise print just "error: null".
            err.println("error: " + e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage()));
            return ERROR;
        }
    }

    // ------------------------------------------------------------------------------------------------------------------
    // jvms / info
    // ------------------------------------------------------------------------------------------------------------------

    /**
     * One Java process as "alfred jvms" shows it. {@code features} is null when Alfred's agent is not loaded;
     * {@code reportsTo} is the Alfred its agent reports to and {@code standby} why it stands down (null when it does
     * not) - what an attacher reads to leave an agent to the Alfred that already has it.
     */
    record Jvm(String pid, String name, String user, String javaVersion, String features, String agentVersion,
               boolean readable, String note, String reportsTo, String standby) {
        Jvm(String pid, String name, String user, String javaVersion, String features, String agentVersion,
            boolean readable, String note) {
            this(pid, name, user, javaVersion, features, agentVersion, readable, note, null, null);
        }
    }

    private int jvms(boolean json) {
        String self = String.valueOf(ProcessHandle.current().pid());
        List<Jvm> jvms = new ArrayList<>();
        for (VirtualMachineDescriptor d : VirtualMachine.list()) {
            if (!d.id().equals(self)) {
                jvms.add(describe(d.id(), d.displayName()));
            }
        }
        if (json) {
            out.println(toJson(jvms));
            return OK;
        }
        if (jvms.isEmpty()) {
            out.println("No Java applications found" + (isLinux() && !isRoot() ? " for this user (run as root to see every user's)." : "."));
            return OK;
        }
        out.printf("%-8s %-40s %-12s %-14s %s%n", "PID", "NAME", "USER", "ALFRED", "NOTE");
        for (Jvm j : jvms) {
            out.printf("%-8s %-40s %-12s %-14s %s%n", j.pid(), clip(j.name(), 40), clip(j.user(), 12),
                    j.features() == null ? (j.readable() ? "-" : "?") : j.features().isEmpty() ? "loaded, off" : j.features(),
                    j.note());
        }
        return OK;
    }

    private int info(String pid, boolean json) {
        Jvm jvm = describe(pid, "");
        out.println(json ? toJson(List.of(jvm)) : jvm.pid() + " " + jvm.name() + " " + Optional.ofNullable(jvm.features()).orElse("-") + " " + jvm.note());
        return OK;
    }

    Jvm describe(String pid, String displayName) {
        String owner = owner(pid).orElse("?");
        String fallbackName = displayName == null || displayName.isBlank() ? "(unknown)" : displayName.split(" ")[0];
        if (!mayAttach(pid)) {
            return new Jvm(pid, fallbackName, owner, "", null, null, false, "owned by " + owner + ": details need that user");
        }
        try {
            Properties props = withVm(pid, VirtualMachine::getSystemProperties);
            return new Jvm(pid, name(props, fallbackName), owner, props.getProperty("java.version", ""),
                    props.getProperty(FEATURES), props.getProperty(VERSION), true, note(props), props.getProperty(AGENT_URL),
                    props.getProperty(STANDBY));
        } catch (Exception e) {
            return new Jvm(pid, fallbackName, owner, "", null, null, false, "cannot attach: " + e.getMessage());
        }
    }

    static String name(Properties props, String fallback) {
        String jboss = props.getProperty("jboss.home.dir");
        if (jboss != null) {
            return "WildFly " + jboss;
        }
        String command = props.getProperty("sun.java.command", "");
        return command.isBlank() ? fallback : command.split(" ")[0];
    }

    static String note(Properties props) {
        List<String> notes = new ArrayList<>();
        if (props.getProperty("javax.net.ssl.trustStore") != null) {
            notes.add("own trust store: HTTPS relies on the agent trusting Alfred's CA");
        }
        String features = props.getProperty(FEATURES);
        String standby = props.getProperty(STANDBY);
        if (standby != null) {
            notes.add("stood down - " + standby);
        } else if (features != null && features.contains("proxy")) {
            String proxy = props.getProperty("https.proxyHost");
            notes.add("outbound through " + proxy + ":" + props.getProperty("https.proxyPort"));
        }
        return String.join("; ", notes);
    }

    // ------------------------------------------------------------------------------------------------------------------
    // attach / detach
    // ------------------------------------------------------------------------------------------------------------------

    private int load(boolean attach, String pid, List<String> options) throws Exception {
        String agent = option(options, "--agent").orElseThrow(() -> new IllegalArgumentException("--agent JAR is required"));
        String base = option(options, "--args").orElse("");
        Set<String> change = features(option(options, attach ? "--add" : "--remove").orElse(attach ? "proxy" : String.join(",", ALL_FEATURES)));
        if (!Files.isReadable(Path.of(agent))) {
            throw new IllegalStateException("cannot read " + agent);
        }
        if (!mayAttach(pid)) {
            throw new NotAllowed("PID " + pid + " belongs to " + owner(pid).orElse("another user")
                    + ": attach as that user (the alfred command does this for you when run as root).");
        }
        VirtualMachine vm = attachTo(pid);
        try {
            Properties before = vm.getSystemProperties();
            String current = before.getProperty(FEATURES);
            if (!attach && current == null) {
                out.println("Alfred is not loaded in PID " + pid + " - nothing to turn off.");
                return OK;
            }
            Set<String> desired = new LinkedHashSet<>(features(current == null ? "" : current));
            if (attach) {
                desired.addAll(change);
            } else {
                desired.removeAll(change);
            }
            String list = ordered(desired);
            String args = agentArgs(base, list);
            try {
                vm.loadAgent(agent, args);
            } catch (AgentLoadException e) {
                if (!jdk8Success(e)) {
                    throw new IllegalStateException("the agent did not load: " + e.getMessage());
                }
            }
            String now = vm.getSystemProperties().getProperty(FEATURES);
            if (!list.equals(now)) {
                throw new IllegalStateException("the agent loaded but reports features '" + now + "' instead of '" + list
                        + "' - see the application's console for [alfred-agent] lines");
            }
            out.println("PID " + pid + " (" + name(before, "java") + "): Alfred " + (list.isEmpty() ? "off" : list));
            return OK;
        } finally {
            vm.detach();
        }
    }

    /** The agent's arguments: the launcher's base (URL, project, proxy) plus the features, the secret and the CA. */
    String agentArgs(String base, String features) throws IOException {
        StringBuilder args = new StringBuilder();
        for (String part : base.split(";")) {
            String key = part.contains("=") ? part.substring(0, part.indexOf('=')).trim() : "";
            if (!part.isBlank() && !key.equals("features")) {
                args.append(args.length() == 0 ? "" : ";").append(part.trim());
            }
        }
        args.append(args.length() == 0 ? "" : ";").append("features=").append(features);
        String secret = env.get("ALFRED_AGENT_SECRET");
        if (secret != null && !secret.isBlank()) {
            args.append(";secret=").append(secret.strip());
        }
        String ca = env.get("ALFRED_AGENT_CA");
        if (ca != null && !ca.isBlank()) {
            args.append(";caFile=").append(caFile(ca));
        }
        return args.toString();
    }

    /** Alfred's CA certificate (public) where the app's user can read it: the install's data folder is owner-only. */
    static Path caFile(String pem) throws IOException {
        try {
            String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(pem.getBytes(StandardCharsets.UTF_8)));
            Path file = Path.of(System.getProperty("java.io.tmpdir"), "alfred-ca-" + hash.substring(0, 16) + ".pem");
            if (!Files.exists(file)) {
                Path temp = Files.createTempFile(file.getParent(), "alfred-ca-", ".tmp");
                Files.writeString(temp, pem);
                Files.move(temp, file, java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
            return file;
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Spike S2: a JDK 8 target's "0" reply, which a JDK 9+ client mistakes for a failure. */
    static boolean jdk8Success(AgentLoadException e) {
        String message = e.getMessage();
        return message != null && message.strip().matches("(?s)(.*\\D)?0");
    }

    static Set<String> features(String list) {
        Set<String> out = new LinkedHashSet<>();
        for (String name : list.split(",")) {
            String feature = name.strip().toLowerCase(Locale.ROOT);
            if (feature.isEmpty()) {
                continue;
            }
            if (!ALL_FEATURES.contains(feature)) {
                throw new IllegalArgumentException("unknown feature '" + feature + "' (known: " + String.join(", ", ALL_FEATURES) + ")");
            }
            out.add(feature);
        }
        return out;
    }

    static String ordered(Set<String> features) {
        return String.join(",", ALL_FEATURES.stream().filter(features::contains).toList());
    }

    private static Optional<String> option(List<String> options, String name) {
        int i = options.indexOf(name);
        return i >= 0 && i + 1 < options.size() ? Optional.of(options.get(i + 1)) : Optional.empty();
    }

    // ------------------------------------------------------------------------------------------------------------------
    // the machine
    // ------------------------------------------------------------------------------------------------------------------

    interface VmCall<T> {
        T call(VirtualMachine vm) throws Exception;
    }

    private <T> T withVm(String pid, VmCall<T> call) throws Exception {
        VirtualMachine vm = attachTo(pid);
        try {
            return call.call(vm);
        } finally {
            vm.detach();
        }
    }

    private static VirtualMachine attachTo(String pid) throws Exception {
        try {
            return VirtualMachine.attach(pid);
        } catch (IOException e) {
            if (!isLinux()) {
                throw new NotAllowed("cannot attach to PID " + pid + " (" + e.getMessage() + "). On Windows a Java app in "
                        + "another session may need 'alfred attach' run from that session as Administrator.");
            }
            throw e;
        }
    }

    /** Never across users on Linux/macOS (spike S2). Windows has no such failure mode; its errors are reported. */
    static boolean mayAttach(String pid) {
        if (!isLinux()) {
            return true;
        }
        Optional<String> owner = owner(pid);
        return owner.isEmpty() || owner.get().equals(System.getProperty("user.name"));
    }

    static Optional<String> owner(String pid) {
        try {
            if (isLinux()) {
                return Optional.of(Files.getOwner(Path.of("/proc", pid)).getName());
            }
            return ProcessHandle.of(Long.parseLong(pid)).flatMap(p -> p.info().user())
                    .map(u -> u.contains("\\") ? u.substring(u.indexOf('\\') + 1) : u);
        } catch (IOException | RuntimeException e) {
            return Optional.empty();
        }
    }

    static boolean isLinux() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("linux");
    }

    private static boolean isRoot() {
        return "root".equals(System.getProperty("user.name"));
    }

    private static String clip(String text, int width) {
        return text.length() <= width ? text : "..." + text.substring(text.length() - width + 3);
    }

    static String toJson(List<Jvm> jvms) {
        StringBuilder json = new StringBuilder("[");
        for (Jvm j : jvms) {
            json.append(json.length() == 1 ? "" : ",").append('{')
                    .append("\"pid\":").append(quote(j.pid())).append(',')
                    .append("\"name\":").append(quote(j.name())).append(',')
                    .append("\"user\":").append(quote(j.user())).append(',')
                    .append("\"javaVersion\":").append(quote(j.javaVersion())).append(',')
                    .append("\"features\":").append(quote(j.features())).append(',')
                    .append("\"agentVersion\":").append(quote(j.agentVersion())).append(',')
                    .append("\"readable\":").append(j.readable()).append(',')
                    .append("\"note\":").append(quote(j.note())).append(',')
                    .append("\"reportsTo\":").append(quote(j.reportsTo())).append(',')
                    .append("\"standby\":").append(quote(j.standby())).append('}');
        }
        return json.append(']').toString();
    }

    private static String quote(String value) {
        if (value == null) {
            return "null";
        }
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        return out.append('"').toString();
    }

    static final class NotAllowed extends RuntimeException {
        NotAllowed(String message) {
            super(message);
        }
    }

    private int usage() {
        err.println("""
                usage: attach-cli jvms [--json] | info PID [--json]
                       attach-cli attach PID --agent JAR --args BASE_ARGS [--add proxy,db,logs,redis]
                       attach-cli detach PID --agent JAR --args BASE_ARGS [--remove proxy,db,logs,redis]""");
        return USAGE;
    }
}
