package com.fathy.alfred.dbagent.proxy;

import java.util.HashMap;
import java.util.Map;

/**
 * Routes this JVM's outbound HTTP and HTTPS through Alfred's forward proxy by its standard system properties (moved
 * from wildfly-proxy-toggle's WildFlyProxyAgent). Both pairs get the same address: the forward proxy tells plain HTTP
 * and HTTPS apart by the request itself. Turning it off restores what the properties were before it was turned on, so
 * an application that had its own proxy gets it back.
 *
 * <p>Clients that read these properties per request (HttpURLConnection, Apache HttpClient with useSystemProperties)
 * follow at once; a client built with its own proxy setting, or the JDK HttpClient built without a ProxySelector,
 * does not (docs/server.md "Attach limits").
 */
public final class ProxySwitch {

    static final String[] KEYS = {"http.proxyHost", "http.proxyPort", "https.proxyHost", "https.proxyPort"};

    /** The values from before the first "on"; null while off. */
    private static Map<String, String> saved;

    private ProxySwitch() {
    }

    /** {@code address} is "host:port"; the last colon splits it, so an IPv6 host in brackets works too. */
    public static synchronized void on(String address) {
        int colon = address.lastIndexOf(':');
        if (colon <= 0 || colon == address.length() - 1) {
            throw new IllegalArgumentException("proxy address must be host:port, got " + address);
        }
        String host = address.substring(0, colon);
        String port = address.substring(colon + 1);
        if (saved == null) {
            saved = new HashMap<>();
            for (String key : KEYS) {
                saved.put(key, System.getProperty(key));
            }
        }
        System.setProperty("http.proxyHost", host);
        System.setProperty("http.proxyPort", port);
        System.setProperty("https.proxyHost", host);
        System.setProperty("https.proxyPort", port);
    }

    public static synchronized void off() {
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
        saved = null;
    }

    public static synchronized boolean isOn() {
        return saved != null;
    }
}
