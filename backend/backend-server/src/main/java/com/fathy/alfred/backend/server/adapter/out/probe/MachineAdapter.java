package com.fathy.alfred.backend.server.adapter.out.probe;

import com.fathy.alfred.backend.server.application.port.out.MachinePort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The machine as the checks see it (FR-030). Read-only and bounded: a port is tested by binding it for a moment, its
 * owner is looked up in /proc (Linux) or netstat/tasklist (Windows) with a timeout, a folder's files are counted one
 * level deep by name only (never opened), and an app's port gets one HEAD request with a 1 s timeout.
 */
public class MachineAdapter implements MachinePort {

    private static final Logger log = LoggerFactory.getLogger(MachineAdapter.class);
    private static final boolean WINDOWS = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    private static final Duration HEALTH_TIMEOUT = Duration.ofSeconds(1);
    private static final long COMMAND_TIMEOUT_SECONDS = 3;
    private static final int MAX_LISTED = 10_000;
    private static final Pattern LOG_FILE = Pattern.compile(".*\\.(log|json|txt)(\\.\\d+)?$", Pattern.CASE_INSENSITIVE);

    private final Path dataDir;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(HEALTH_TIMEOUT).build();

    public MachineAdapter(Path dataDir) {
        this.dataDir = dataDir;
    }

    @Override
    public Optional<String> portOwner(int port) {
        if (isFree(port)) {
            return Optional.empty();
        }
        String owner = WINDOWS ? windowsOwner(port) : linuxOwner(port);
        return Optional.of(owner == null ? "a process (unknown)" : owner);
    }

    private static boolean isFree(int port) {
        try (ServerSocket socket = new ServerSocket()) {
            socket.setReuseAddress(false);
            socket.bind(new InetSocketAddress(port));
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /** /proc/net/tcp(6): the LISTEN socket's inode, then the process holding a file descriptor on it. */
    private static String linuxOwner(int port) {
        String hexPort = String.format(":%04X ", port);
        String inode = null;
        for (String table : List.of("/proc/net/tcp", "/proc/net/tcp6")) {
            try {
                for (String line : Files.readAllLines(Path.of(table))) {
                    String[] f = line.trim().split("\\s+");
                    if (f.length > 9 && f[1].endsWith(hexPort.trim()) && "0A".equals(f[3])) {
                        inode = f[9];
                    }
                }
            } catch (IOException e) {
                // table not there (no IPv6) - the other one may have it
            }
        }
        if (inode == null) {
            return null;
        }
        String target = "socket:[" + inode + "]";
        try (DirectoryStream<Path> procs = Files.newDirectoryStream(Path.of("/proc"), p -> p.getFileName().toString().matches("\\d+"))) {
            for (Path proc : procs) {
                try (DirectoryStream<Path> fds = Files.newDirectoryStream(proc.resolve("fd"))) {
                    for (Path fd : fds) {
                        if (target.equals(Files.readSymbolicLink(fd).toString())) {
                            String name = Files.readString(proc.resolve("comm")).trim();
                            return name + " (pid " + proc.getFileName() + ")";
                        }
                    }
                } catch (IOException | SecurityException e) {
                    // another user's process: not visible to the service account
                }
            }
        } catch (IOException e) {
            return null;
        }
        return null;
    }

    private static String windowsOwner(int port) {
        String netstat = run("netstat", "-ano", "-p", "TCP");
        if (netstat == null) {
            return null;
        }
        Matcher m = Pattern.compile("^\\s*TCP\\s+\\S+:" + port + "\\s+\\S+\\s+LISTENING\\s+(\\d+)", Pattern.MULTILINE).matcher(netstat);
        if (!m.find()) {
            return null;
        }
        String pid = m.group(1);
        String task = run("tasklist", "/FI", "PID eq " + pid, "/FO", "CSV", "/NH");
        String name = task == null ? null : task.trim().split(",")[0].replace("\"", "");
        return (name == null || name.isEmpty() || name.startsWith("INFO") ? "a process" : name) + " (pid " + pid + ")";
    }

    private static String run(String... command) {
        try {
            Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
            byte[] out = process.getInputStream().readAllBytes();
            if (!process.waitFor(COMMAND_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                return null;
            }
            return new String(out, StandardCharsets.UTF_8);
        } catch (IOException e) {
            log.debug("{} failed: {}", command[0], e.getMessage());
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
    }

    @Override
    public FolderInfo folder(String path) {
        Path folder = Path.of(path);
        if (!Files.isDirectory(folder)) {
            return new FolderInfo(false, false, 0, 0);
        }
        if (!Files.isReadable(folder)) {
            return new FolderInfo(true, false, 0, 0);
        }
        int count = 0;
        long newest = 0;
        int seen = 0;
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(folder)) {
            for (Path entry : entries) {
                if (++seen > MAX_LISTED) {
                    break;
                }
                if (Files.isRegularFile(entry) && LOG_FILE.matcher(entry.getFileName().toString()).matches()) {
                    count++;
                    newest = Math.max(newest, Files.getLastModifiedTime(entry).toMillis());
                }
            }
        } catch (IOException e) {
            return new FolderInfo(true, false, 0, 0);
        }
        return new FolderInfo(true, true, count, newest);
    }

    @Override
    public long freeDiskBytes() {
        try {
            Path probe = Files.exists(dataDir) ? dataDir : dataDir.toAbsolutePath().getRoot();
            return Files.getFileStore(probe).getUsableSpace();
        } catch (IOException | NullPointerException e) {
            return -1;
        }
    }

    @Override
    public long totalMemoryBytes() {
        return ManagementFactory.getOperatingSystemMXBean() instanceof com.sun.management.OperatingSystemMXBean os
                ? os.getTotalMemorySize() : -1;
    }

    @Override
    public long freeMemoryBytes() {
        return ManagementFactory.getOperatingSystemMXBean() instanceof com.sun.management.OperatingSystemMXBean os
                ? os.getFreeMemorySize() : -1;
    }

    @Override
    public AppHealth appHealth(int port) {
        long started = System.nanoTime();
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/"))
                    .timeout(HEALTH_TIMEOUT).method("HEAD", HttpRequest.BodyPublishers.noBody()).build();
            int status = http.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
            return new AppHealth(status, (System.nanoTime() - started) / 1_000_000, "");
        } catch (ConnectException e) {
            return new AppHealth(-1, 0, "nothing listening on " + port);
        } catch (IOException e) {
            return new AppHealth(-1, 0, "no answer within 1 s");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new AppHealth(-1, 0, "interrupted");
        }
    }
}
