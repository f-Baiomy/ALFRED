import java.lang.instrument.Instrumentation;

/**
 * WildFlyProxyAgent - runs inside the target WildFly JVM once WildFlyProxyController's
 * loadAgent() call completes. Deliberately has ZERO reference to com.sun.tools.attach.* (not
 * even indirectly, e.g. via another method in the same class) - the target JVM has to load and
 * verify this exact class's method signatures to find agentmain(), and it has no tools.jar on
 * its own classpath to resolve those types with (confirmed live: NoClassDefFoundError for
 * com.sun.tools.attach.VirtualMachineDescriptor when agentmain lived in the same class as the
 * attach-API-using controller code, even though agentmain itself never called any of it).
 */
public class WildFlyProxyAgent {

    private static final String HTTPS_PROXY_HOST = "https.proxyHost";
    private static final String HTTPS_PROXY_PORT = "https.proxyPort";

    /** agentArgs is "on:<host>:<port>", "off", or "status" - encoding the proxy host/port into
     * the single string loadAgent() accepts, since it has no way to pass structured arguments. */
    public static void agentmain(String agentArgs, Instrumentation instrumentation) {
        if (agentArgs.startsWith("on:")) {
            String[] parts = agentArgs.split(":", 3);
            System.setProperty(HTTPS_PROXY_HOST, parts[1]);
            System.setProperty(HTTPS_PROXY_PORT, parts[2]);
            System.out.println("[wildfly-proxy-toggle] Proxy ON - HTTPS traffic in this JVM now routes through "
                    + parts[1] + ":" + parts[2]);
        } else if (agentArgs.equals("off")) {
            System.clearProperty(HTTPS_PROXY_HOST);
            System.clearProperty(HTTPS_PROXY_PORT);
            System.out.println("[wildfly-proxy-toggle] Proxy OFF - HTTPS traffic in this JVM goes direct again.");
        } else if (agentArgs.equals("status")) {
            String host = System.getProperty(HTTPS_PROXY_HOST);
            String port = System.getProperty(HTTPS_PROXY_PORT);
            System.out.println(host == null || port == null
                    ? "[wildfly-proxy-toggle] Proxy status: DISABLED"
                    : "[wildfly-proxy-toggle] Proxy status: ENABLED, routing through " + host + ":" + port);
        }
    }
}
