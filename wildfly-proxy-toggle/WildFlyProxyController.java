import com.sun.tools.attach.VirtualMachine;
import com.sun.tools.attach.VirtualMachineDescriptor;

import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.Scanner;

/**
 * WildFlyProxyController - turns an already-running WildFly JVM's https.proxyHost/
 * https.proxyPort system properties on or off via the Java Attach API, without restarting
 * WildFly, hand-editing standalone.xml (not even transiently, unlike the jboss-cli/management-
 * CLI approach), or changing any launch configuration.
 *
 * Detects the running WildFly instance by attaching to each candidate JVM in turn and checking
 * for a "jboss.home.dir" system property - more precise than matching on the free-text
 * VirtualMachineDescriptor.displayName() (confirmed live: displayName() does contain
 * "org.jboss.as.standalone" for a real WildFly process, but getSystemProperties() gives an exact
 * signal plus the actual property values, with no regex parsing needed at all). If exactly one
 * match is found it's used automatically; if several are found, the user is prompted to pick one.
 *
 * Unlike the jboss-cli-based approach, this never needs to locate WildFly's management port or
 * even for its management interface to be enabled at all - WildFlyProxyAgent.agentmain() runs
 * INSIDE the target JVM via the standard Instrumentation agent mechanism, so
 * System.setProperty() there is a normal in-process call, not a remote management operation.
 * "status" doesn't even need the agent - VirtualMachine.getSystemProperties() can read the
 * target's properties directly over the same attach connection used for detection.
 *
 * The agent class lives in a SEPARATE file/class (WildFlyProxyAgent.java) deliberately - the
 * target JVM has to load and verify that class's method signatures to find agentmain(), and it
 * has no tools.jar on its own classpath to resolve com.sun.tools.attach.* types with (confirmed
 * live: NoClassDefFoundError for VirtualMachineDescriptor when agentmain lived in this same
 * class, even though agentmain itself never called any attach-API code).
 *
 * Java 8 target (the only JVM available here) - needs $JAVA_HOME/lib/tools.jar on the classpath
 * for com.sun.tools.attach.*, which isn't included by default; see proxy-on.bat/proxy-on.sh.
 *
 * Usage: java -cp <out>;<tools.jar> -DAGENT_JAR=<path-to-built-agent-jar> WildFlyProxyController <on|off|status>
 * Env vars: WILDFLY_PID (skip the prompt, pick a specific detected PID), PROXY_HOST/PROXY_PORT
 * (default 127.0.0.2/443).
 */
public class WildFlyProxyController {

    public static void main(String[] args) throws Exception {
        if (args.length != 1 || !(args[0].equals("on") || args[0].equals("off") || args[0].equals("status"))) {
            System.err.println("Usage: java WildFlyProxyController <on|off|status>");
            System.exit(1);
            return;
        }
        String command = args[0];

        VirtualMachineDescriptor chosen = findWildFlyJvm();
        if (chosen == null) {
            System.err.println("No running WildFly instance found (looked for a java process with a");
            System.err.println("\"jboss.home.dir\" system property).");
            System.exit(1);
            return;
        }

        System.out.println("Using WildFly at PID " + chosen.id());

        if (command.equals("status")) {
            VirtualMachine vm = VirtualMachine.attach(chosen);
            try {
                Properties props = vm.getSystemProperties();
                String host = props.getProperty("https.proxyHost");
                String port = props.getProperty("https.proxyPort");
                System.out.println(host == null || port == null
                        ? "Proxy status: DISABLED"
                        : "Proxy status: ENABLED, routing through " + host + ":" + port);
            } finally {
                vm.detach();
            }
            return;
        }

        String agentJar = System.getProperty("AGENT_JAR");
        if (agentJar == null || agentJar.trim().isEmpty()) {
            System.err.println("Missing -DAGENT_JAR=<path> - this controller needs to know where the");
            System.err.println("built WildFlyProxyAgent jar is, since it isn't launched from it directly.");
            System.exit(1);
            return;
        }

        String proxyHost = nonBlank(System.getenv("PROXY_HOST"), "127.0.0.2");
        String proxyPort = nonBlank(System.getenv("PROXY_PORT"), "443");
        String agentArgs = command.equals("on") ? ("on:" + proxyHost + ":" + proxyPort) : "off";

        VirtualMachine vm = VirtualMachine.attach(chosen);
        try {
            vm.loadAgent(agentJar, agentArgs);
        } finally {
            vm.detach();
        }

        // loadAgent() only throws if the agent itself failed - reaching here means agentmain ran
        // to completion, so this is a genuine confirmation, not an assumption. agentmain's own
        // System.out lines land in the TARGET JVM's console (e.g. IntelliJ's run window for
        // WildFly), not here, so this side needs its own confirmation independently of that.
        if (command.equals("on")) {
            System.out.println("Proxy ON - HTTPS traffic in this WildFly JVM now routes through " + proxyHost + ":" + proxyPort);
            System.out.println("Run with \"off\" to disable.");
        } else {
            System.out.println("Proxy OFF - HTTPS traffic in this WildFly JVM goes direct again.");
        }
    }

    private static String nonBlank(String value, String fallback) {
        return (value != null && !value.trim().isEmpty()) ? value.trim() : fallback;
    }

    private static VirtualMachineDescriptor findWildFlyJvm() throws Exception {
        List<VirtualMachineDescriptor> candidates = new ArrayList<VirtualMachineDescriptor>();
        for (VirtualMachineDescriptor d : VirtualMachine.list()) {
            if (isWildFly(d)) {
                candidates.add(d);
            }
        }

        if (candidates.isEmpty()) {
            return null;
        }

        String pidOverride = System.getenv("WILDFLY_PID");
        if (pidOverride != null && !pidOverride.trim().isEmpty()) {
            return selectByPid(candidates, pidOverride.trim());
        }

        if (candidates.size() == 1) {
            System.out.println("Detected one running WildFly instance: PID " + candidates.get(0).id());
            return candidates.get(0);
        }

        if (System.console() == null) {
            System.err.println("Multiple WildFly instances detected, and this isn't an interactive");
            System.err.println("terminal - set WILDFLY_PID to pick one without prompting:");
            printCandidates(candidates, System.err);
            System.exit(1);
            return null;
        }

        System.out.println("Multiple WildFly instances detected:");
        printCandidates(candidates, System.out);

        Scanner scanner = new Scanner(System.in);
        while (true) {
            System.out.print("Choose [1-" + candidates.size() + "]: ");
            String line = scanner.nextLine().trim();
            try {
                int idx = Integer.parseInt(line);
                if (idx >= 1 && idx <= candidates.size()) {
                    return candidates.get(idx - 1);
                }
            } catch (NumberFormatException ignored) {
                // fall through to the "invalid choice" message below
            }
            System.out.println("Invalid choice, try again.");
        }
    }

    private static void printCandidates(List<VirtualMachineDescriptor> candidates, java.io.PrintStream out) {
        for (int i = 0; i < candidates.size(); i++) {
            VirtualMachineDescriptor d = candidates.get(i);
            out.println("  [" + (i + 1) + "] PID " + d.id() + "  " + homeDirOf(d));
        }
    }

    private static VirtualMachineDescriptor selectByPid(List<VirtualMachineDescriptor> candidates, String pidStr) {
        for (VirtualMachineDescriptor d : candidates) {
            if (d.id().equals(pidStr)) {
                return d;
            }
        }
        System.err.println("WILDFLY_PID=" + pidStr + " does not match any detected WildFly instance.");
        System.err.println("Detected PIDs:");
        for (VirtualMachineDescriptor d : candidates) {
            System.err.println("  " + d.id());
        }
        System.exit(1);
        return null;
    }

    /** Attaches briefly just to check for "jboss.home.dir" - more precise than matching
     * displayName() text, and confirmed live to work reliably for this exact purpose. */
    private static boolean isWildFly(VirtualMachineDescriptor descriptor) {
        try {
            VirtualMachine vm = VirtualMachine.attach(descriptor);
            try {
                return vm.getSystemProperties().containsKey("jboss.home.dir");
            } finally {
                vm.detach();
            }
        } catch (Exception e) {
            return false;
        }
    }

    private static String homeDirOf(VirtualMachineDescriptor descriptor) {
        try {
            VirtualMachine vm = VirtualMachine.attach(descriptor);
            try {
                String home = vm.getSystemProperties().getProperty("jboss.home.dir");
                return home != null ? home : "(unknown install dir)";
            } finally {
                vm.detach();
            }
        } catch (Exception e) {
            return "(unknown install dir)";
        }
    }
}
