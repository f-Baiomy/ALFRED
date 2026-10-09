import java.lang.instrument.Instrumentation;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.Map;

/**
 * WildFlyProxyAgent - runs inside the target WildFly JVM once WildFlyProxyController's
 * loadAgent() call completes. Deliberately has ZERO reference to com.sun.tools.attach.* (not
 * even indirectly, e.g. via another method in the same class) - the target JVM has to load and
 * verify this exact class's method signatures to find agentmain(), and it has no tools.jar on
 * its own classpath to resolve those types with (confirmed live: NoClassDefFoundError for
 * com.sun.tools.attach.VirtualMachineDescriptor when agentmain lived in the same class as the
 * attach-API-using controller code, even though agentmain itself never called any of it).
 *
 * While "on", a daemon thread watches the proxy's port: when Alfred stops (nothing accepts a
 * connection there for MISSED_TO_STAND_DOWN checks in a row) the JVM's own proxy settings come
 * back, so its outbound calls go direct instead of failing against a proxy that is gone; when the
 * port accepts again, the proxy is switched back on. "off" stops the watcher.
 */
public class WildFlyProxyAgent {

    private static final String HTTPS_PROXY_HOST = "https.proxyHost";
    private static final String HTTPS_PROXY_PORT = "https.proxyPort";
    private static final String HTTP_PROXY_HOST = "http.proxyHost";
    private static final String HTTP_PROXY_PORT = "http.proxyPort";
    private static final String[] KEYS = {HTTPS_PROXY_HOST, HTTPS_PROXY_PORT, HTTP_PROXY_HOST, HTTP_PROXY_PORT};
    /** Set while the proxy stands down because Alfred's proxy is unreachable - "proxy-status" and "alfred jvms" show it. */
    static final String STANDBY_PROPERTY = "alfred.agent.standby";

    static long checkEveryMillis = 5_000;
    static final int CONNECT_TIMEOUT_MILLIS = 1_000;
    static final int MISSED_TO_STAND_DOWN = 3;

    /** The JVM's own values from before the first "on"; null while off. */
    private static Map<String, String> saved;
    private static String host;
    private static int port;
    private static boolean standingDown;
    private static Thread watcher;

    /** agentArgs is "on:<host>:<port>", "off", or "status" - encoding the proxy host/port into
     * the single string loadAgent() accepts, since it has no way to pass structured arguments.
     * Sets BOTH the https.* and http.* system properties to the same host/port - Alfred's forward
     * proxy (mitmproxy in "regular" mode) tells plain HTTP and HTTPS apart by the request itself
     * (an HTTP CONNECT vs an absolute-URI request line), not by which port it's reached on, so one
     * proxy address handles both. Without the http.* pair, this JVM's plain-HTTP outbound calls
     * would never route through Alfred at all and so would never get logged. */
    public static void agentmain(String agentArgs, Instrumentation instrumentation) {
        if (agentArgs.startsWith("on:")) {
            String[] parts = agentArgs.split(":", 3);
            on(parts[1], Integer.parseInt(parts[2]));
            System.out.println("[wildfly-proxy-toggle] Proxy ON - HTTP/HTTPS traffic in this JVM now routes through "
                    + parts[1] + ":" + parts[2]);
        } else if (agentArgs.equals("off")) {
            off();
            System.out.println("[wildfly-proxy-toggle] Proxy OFF - HTTP/HTTPS traffic in this JVM goes direct again.");
        } else if (agentArgs.equals("status")) {
            System.out.println("[wildfly-proxy-toggle] Proxy status: " + status());
        }
    }

    static synchronized void on(String newHost, int newPort) {
        if (saved == null) {
            saved = new HashMap<>();
            for (String key : KEYS) {
                saved.put(key, System.getProperty(key));
            }
        }
        host = newHost;
        port = newPort;
        standingDown = false;
        System.clearProperty(STANDBY_PROPERTY);
        route();
        if (watcher == null) {
            watcher = new Thread(WildFlyProxyAgent::watch, "alfred-proxy-watch");
            watcher.setDaemon(true);
            watcher.start();
        }
    }

    static synchronized void off() {
        if (watcher != null) {
            watcher.interrupt();
            watcher = null;
        }
        standingDown = false;
        System.clearProperty(STANDBY_PROPERTY);
        restore();
        saved = null;
    }

    static synchronized String status() {
        if (standingDown) {
            return "STOOD DOWN - " + System.getProperty(STANDBY_PROPERTY) + "; resumes through " + host + ":" + port + " when it is back";
        }
        String h = System.getProperty(HTTPS_PROXY_HOST);
        String p = System.getProperty(HTTPS_PROXY_PORT);
        return saved == null || h == null || p == null ? "DISABLED" : "ENABLED, routing through " + h + ":" + p;
    }

    private static void route() {
        String p = String.valueOf(port);
        System.setProperty(HTTPS_PROXY_HOST, host);
        System.setProperty(HTTPS_PROXY_PORT, p);
        System.setProperty(HTTP_PROXY_HOST, host);
        System.setProperty(HTTP_PROXY_PORT, p);
    }

    /** The values the JVM had before "on" - its own proxy, if it had one, rather than none. */
    private static void restore() {
        if (saved == null) {
            return;
        }
        for (String key : KEYS) {
            String value = saved.get(key);
            if (value == null) {
                System.clearProperty(key);
            } else {
                System.setProperty(key, value);
            }
        }
    }

    private static void watch() {
        int missed = 0;
        while (!Thread.currentThread().isInterrupted()) {
            try {
                Thread.sleep(checkEveryMillis);
            } catch (InterruptedException e) {
                return;
            }
            String h;
            int p;
            synchronized (WildFlyProxyAgent.class) {
                if (watcher != Thread.currentThread()) {
                    return;
                }
                h = host;
                p = port;
            }
            boolean up = reachable(h, p);
            synchronized (WildFlyProxyAgent.class) {
                if (watcher != Thread.currentThread() || !h.equals(host) || p != port) {
                    missed = 0; // switched off, or on again with another address, while this check ran
                    continue;
                }
                if (up) {
                    missed = 0;
                    if (standingDown) {
                        standingDown = false;
                        System.clearProperty(STANDBY_PROPERTY);
                        route();
                        System.out.println("[wildfly-proxy-toggle] Alfred proxy " + h + ":" + p + " is back - routing through it again");
                    }
                } else if (!standingDown && ++missed >= MISSED_TO_STAND_DOWN) {
                    standingDown = true;
                    restore();
                    System.setProperty(STANDBY_PROPERTY, "Alfred proxy " + h + ":" + p + " unreachable since "
                            + new SimpleDateFormat("HH:mm").format(new Date()));
                    System.out.println("[wildfly-proxy-toggle] Alfred proxy " + h + ":" + p + " unreachable - outbound calls go direct until it is back");
                }
            }
        }
    }

    private static boolean reachable(String h, int p) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(h, p), CONNECT_TIMEOUT_MILLIS);
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
