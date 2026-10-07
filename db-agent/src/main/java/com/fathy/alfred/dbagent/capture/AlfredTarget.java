package com.fathy.alfred.dbagent.capture;

/**
 * Where Alfred is, as the reverse proxy says it on every request it forwards ({@code alfred=<url>} and
 * {@code key=<issued>.<hmac>} in X-Alfred-Call). The agent reports to THAT Alfred, whatever its own arguments
 * said when it was loaded: a {@code -javaagent} line written for a port nothing listens on any more, or for a
 * Docker install replaced by a native one, otherwise silently sends every statement and log line into the void
 * while the calls themselves are logged by the proxy that stamped this header.
 */
public final class AlfredTarget {

    public final String url;
    /** A key backend accepts in place of the webhook secret for a day; null when the proxy had no secret. */
    public final String key;

    AlfredTarget(String url, String key) {
        this.url = url;
        this.key = key;
    }

    /** Null unless the header names an http(s) URL. Unknown parts are ignored, as everywhere in this header. */
    public static AlfredTarget fromHeader(String header) {
        if (header == null || header.isEmpty()) {
            return null;
        }
        String url = null;
        String key = null;
        for (String part : header.split(";")) {
            String p = part.trim();
            int eq = p.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            String name = p.substring(0, eq).trim();
            String value = p.substring(eq + 1).trim();
            if (name.equals("alfred")) {
                url = value;
            } else if (name.equals("key")) {
                key = value;
            }
        }
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            return null;
        }
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        return new AlfredTarget(url, key == null || key.isEmpty() ? null : key);
    }
}
