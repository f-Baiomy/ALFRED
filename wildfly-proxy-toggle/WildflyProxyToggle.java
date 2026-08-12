import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Scanner;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * WildflyProxyToggle - turns an already-running WildFly JVM's https.proxyHost/https.proxyPort
 * system properties on or off via the management CLI (jboss-cli), without restarting WildFly,
 * hand-editing standalone.xml, or changing any launch configuration.
 *
 * Detects the running WildFly instance itself (by scanning for a java process with
 * "org.jboss.as.standalone" on its command line) rather than requiring WILDFLY_HOME to be set -
 * if exactly one is found it's used automatically; if several are found, the user is prompted to
 * pick one. WILDFLY_HOME/CONTROLLER remain available as manual overrides for cases where
 * detection can't see the process (e.g. running as a different user, or in a container).
 *
 * Java 8 target deliberately (no ProcessHandle, no single-file source launch) - the only Java
 * available in this environment. Detection shells out to PowerShell (Windows) or ps (Linux/
 * macOS) instead.
 *
 * Usage: java WildflyProxyToggle <on|off>
 * Env vars: WILDFLY_PID (skip the prompt, pick a specific detected PID), WILDFLY_HOME/CONTROLLER
 * (manual overrides), PROXY_HOST/PROXY_PORT (default 127.0.0.2/443).
 */
public class WildflyProxyToggle {

    private static final boolean IS_WINDOWS = System.getProperty("os.name", "").toLowerCase().contains("win");

    private static final Pattern MANAGEMENT_PORT = Pattern.compile("-Djboss\\.management\\.http\\.port=(\\d+)");
    private static final Pattern PORT_OFFSET = Pattern.compile("-Djboss\\.socket\\.binding\\.port-offset=(\\d+)");
    private static final Pattern BIND_ADDRESS = Pattern.compile("-Djboss\\.bind\\.address\\.management=(\\S+)");
    private static final Pattern HOME_DIR_QUOTED = Pattern.compile("\"-Djboss\\.home\\.dir=([^\"]+)\"");
    private static final Pattern HOME_DIR_UNQUOTED = Pattern.compile("-Djboss\\.home\\.dir=(\\S+)");

    static class Candidate {
        final long pid;
        final String commandLine;

        Candidate(long pid, String commandLine) {
            this.pid = pid;
            this.commandLine = commandLine;
        }

        String homeDir() {
            Matcher m = HOME_DIR_QUOTED.matcher(commandLine);
            if (m.find()) return m.group(1);
            m = HOME_DIR_UNQUOTED.matcher(commandLine);
            return m.find() ? m.group(1) : null;
        }

        int managementPort() {
            Matcher m = MANAGEMENT_PORT.matcher(commandLine);
            if (m.find()) return Integer.parseInt(m.group(1));
            m = PORT_OFFSET.matcher(commandLine);
            if (m.find()) return 9990 + Integer.parseInt(m.group(1));
            return 9990;
        }

        String bindAddress() {
            Matcher m = BIND_ADDRESS.matcher(commandLine);
            return m.find() ? m.group(1) : "localhost";
        }
    }

    static class CliResult {
        final int exitCode;
        final String output;

        CliResult(int exitCode, String output) {
            this.exitCode = exitCode;
            this.output = output;
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 1 || !(args[0].equals("on") || args[0].equals("off"))) {
            System.err.println("Usage: java WildflyProxyToggle <on|off>");
            System.exit(1);
            return;
        }
        String action = args[0];

        String manualHome = System.getenv("WILDFLY_HOME");
        String manualController = System.getenv("CONTROLLER");

        List<Candidate> candidates = findWildflyCandidates();

        if (candidates.isEmpty() && manualHome == null) {
            System.err.println("No running WildFly instance found (looked for a java process with");
            System.err.println("\"org.jboss.as.standalone\" on its command line).");
            System.err.println("If it's running but not visible here (different user/container), set");
            System.err.println("WILDFLY_HOME and CONTROLLER manually instead.");
            System.exit(1);
            return;
        }

        String homeDir;
        String controller;
        Long chosenPid = null;

        if (candidates.isEmpty()) {
            homeDir = manualHome;
            controller = nonBlank(manualController, "localhost:9990");
        } else {
            Candidate chosen;
            String pidOverride = System.getenv("WILDFLY_PID");
            if (pidOverride != null && !pidOverride.trim().isEmpty()) {
                chosen = selectByPid(candidates, pidOverride.trim());
            } else if (candidates.size() == 1) {
                chosen = candidates.get(0);
                System.out.println("Detected one running WildFly instance: PID " + chosen.pid);
            } else {
                chosen = promptForChoice(candidates);
            }
            chosenPid = chosen.pid;
            homeDir = chosen.homeDir() != null ? chosen.homeDir() : manualHome;
            controller = manualController != null && !manualController.trim().isEmpty()
                    ? manualController.trim()
                    : chosen.bindAddress() + ":" + chosen.managementPort();
        }

        if (homeDir == null) {
            System.err.println("Could not determine WildFly's install directory"
                    + (chosenPid != null ? " from PID " + chosenPid + "'s command line" : "")
                    + ", and WILDFLY_HOME isn't set as a fallback.");
            System.exit(1);
            return;
        }

        File cliFile = new File(homeDir, IS_WINDOWS ? "bin\\jboss-cli.bat" : "bin/jboss-cli.sh");
        if (!cliFile.isFile()) {
            System.err.println("Could not find " + cliFile + " - is the WildFly install directory correct?");
            System.exit(1);
            return;
        }

        System.out.println("Using WildFly at " + homeDir
                + (chosenPid != null ? " (PID " + chosenPid + ")" : "")
                + ", management interface at " + controller);

        String proxyHost = nonBlank(System.getenv("PROXY_HOST"), "127.0.0.2");
        String proxyPort = nonBlank(System.getenv("PROXY_PORT"), "443");

        if (action.equals("on")) {
            // Best-effort cleanup first so re-running this is idempotent - a property that's
            // already set would otherwise make :add() fail with "already exists". Its result is
            // deliberately ignored either way.
            runCli(cliFile, controller,
                    "/system-property=https.proxyHost:remove(),/system-property=https.proxyPort:remove()");

            CliResult result = runCli(cliFile, controller,
                    "/system-property=https.proxyHost:add(value=" + proxyHost + "),"
                            + "/system-property=https.proxyPort:add(value=" + proxyPort + ")");
            System.out.print(result.output);
            if (result.exitCode != 0) {
                System.err.println();
                System.err.println("Failed to enable the proxy - see output above.");
                System.exit(1);
                return;
            }
            System.out.println();
            System.out.println("Proxy ON - HTTPS traffic in this WildFly JVM now routes through "
                    + proxyHost + ":" + proxyPort);
            System.out.println("Run with \"off\" to disable.");
        } else {
            CliResult result = runCli(cliFile, controller,
                    "/system-property=https.proxyHost:remove(),/system-property=https.proxyPort:remove()");
            System.out.print(result.output);
            // A "not found" error just means the proxy was already off (nothing to remove) - the
            // desired end state either way. Anything else - connection refused, auth failure, a
            // CLI/server management-protocol version mismatch, ... - is a real failure.
            boolean benignAlreadyOff = result.output.toLowerCase().contains("not found");
            if (result.exitCode != 0 && !benignAlreadyOff) {
                System.err.println();
                System.err.println("Failed to disable the proxy - see output above.");
                System.exit(1);
                return;
            }
            System.out.println();
            System.out.println("Proxy OFF - HTTPS traffic in this WildFly JVM goes direct again.");
        }
    }

    private static String nonBlank(String value, String fallback) {
        return (value != null && !value.trim().isEmpty()) ? value.trim() : fallback;
    }

    private static Candidate selectByPid(List<Candidate> candidates, String pidStr) {
        long wanted;
        try {
            wanted = Long.parseLong(pidStr);
        } catch (NumberFormatException e) {
            System.err.println("WILDFLY_PID is not a valid number: " + pidStr);
            System.exit(1);
            return null;
        }
        for (Candidate c : candidates) {
            if (c.pid == wanted) return c;
        }
        System.err.println("WILDFLY_PID=" + wanted + " does not match any detected WildFly instance.");
        System.err.println("Detected PIDs: ");
        for (Candidate c : candidates) {
            System.err.println("  " + c.pid);
        }
        System.exit(1);
        return null;
    }

    private static Candidate promptForChoice(List<Candidate> candidates) {
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

    private static void printCandidates(List<Candidate> candidates, java.io.PrintStream out) {
        for (int i = 0; i < candidates.size(); i++) {
            Candidate c = candidates.get(i);
            String home = c.homeDir() != null ? c.homeDir() : "(unknown install dir)";
            out.println("  [" + (i + 1) + "] PID " + c.pid + "  " + home + "  management port " + c.managementPort());
        }
    }

    /** Scans running java processes for one whose command line contains "org.jboss.as.standalone"
     * (WildFly's own standalone-mode bootstrap main class) - shells out to PowerShell on Windows
     * or ps on Linux/macOS, since Java 8 has no ProcessHandle to do this natively. */
    private static List<Candidate> findWildflyCandidates() throws IOException, InterruptedException {
        List<Candidate> result = new ArrayList<Candidate>();
        // Deliberately no embedded double quotes in the PowerShell one-liner - ProcessBuilder on
        // Windows reconstructs a single command-line string for the child process, and a
        // long-standing JDK quirk mangles/drops double quotes in that process when the target is
        // itself an interpreter like PowerShell (confirmed live: silently strips them, producing
        // a parse error). Single-quoted PowerShell string literals and [char]9 (tab) instead of
        // `t sidestep the whole problem.
        Process proc = IS_WINDOWS
                ? new ProcessBuilder("powershell", "-NoProfile", "-Command",
                        "Get-CimInstance Win32_Process -Filter 'Name=''java.exe''' | ForEach-Object { $_.ProcessId.ToString() + [char]9 + $_.CommandLine }")
                        .redirectErrorStream(true).start()
                : new ProcessBuilder("ps", "-eo", "pid,args").redirectErrorStream(true).start();

        BufferedReader reader = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8));
        try {
            String line;
            while ((line = reader.readLine()) != null) {
                Candidate c = IS_WINDOWS ? parseWindowsLine(line) : parseUnixLine(line);
                if (c != null && c.commandLine.contains("org.jboss.as.standalone")) {
                    result.add(c);
                }
            }
        } finally {
            reader.close();
        }
        proc.waitFor();
        return result;
    }

    private static Candidate parseWindowsLine(String line) {
        int tab = line.indexOf('\t');
        if (tab < 0) return null;
        try {
            long pid = Long.parseLong(line.substring(0, tab).trim());
            return new Candidate(pid, line.substring(tab + 1));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static Candidate parseUnixLine(String line) {
        line = line.trim();
        int sp = line.indexOf(' ');
        if (sp < 0) return null;
        try {
            long pid = Long.parseLong(line.substring(0, sp));
            return new Candidate(pid, line.substring(sp + 1).trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** Runs jboss-cli non-interactively with the given --commands, capturing its combined
     * stdout+stderr. NOPAUSE is set because jboss-cli.bat itself ends with "if not defined
     * NOPAUSE pause" - without it, that prompt would be invisible (since we're capturing output
     * rather than showing it live) but would still block forever waiting on stdin. Input is also
     * closed outright as a second safety net against the same class of hang. */
    private static CliResult runCli(File cliFile, String controller, String commands) throws IOException, InterruptedException {
        List<String> cmd = new ArrayList<String>();
        if (IS_WINDOWS) {
            cmd.add("cmd.exe");
            cmd.add("/c");
        } else {
            cmd.add("bash");
        }
        cmd.add(cliFile.getAbsolutePath());
        cmd.add("--connect");
        cmd.add("--controller=" + controller);
        cmd.add("--commands=" + commands);

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.environment().put("NOPAUSE", "1");
        pb.redirectErrorStream(true);
        pb.redirectInput(new File(IS_WINDOWS ? "NUL" : "/dev/null"));
        Process proc = pb.start();

        StringBuilder sb = new StringBuilder();
        BufferedReader reader = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8));
        try {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append(System.lineSeparator());
            }
        } finally {
            reader.close();
        }
        int exitCode = proc.waitFor();
        return new CliResult(exitCode, sb.toString());
    }
}
