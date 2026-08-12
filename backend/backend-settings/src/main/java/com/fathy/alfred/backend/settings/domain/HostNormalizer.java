package com.fathy.alfred.backend.settings.domain;

/**
 * Extracts a bare, lowercase hostname from whatever a user typed ("https://example.com/foo?x=1",
 * "example.com/", "EXAMPLE.COM:8443") or from a real call's full URL - both whitelist/blacklist
 * entries and the incoming call being checked against them are normalized through this same
 * method, so matching is a plain equals() on the result regardless of scheme/path/query/port/case.
 */
public final class HostNormalizer {

    private HostNormalizer() {
    }

    /** @return the normalized hostname, or an empty string if none could be extracted (e.g. blank input). */
    public static String normalize(String input) {
        if (input == null) {
            return "";
        }
        String s = input.trim();
        if (s.isEmpty()) {
            return "";
        }

        int schemeIdx = s.indexOf("://");
        if (schemeIdx >= 0) {
            s = s.substring(schemeIdx + 3);
        }

        int cut = s.length();
        for (char c : new char[]{'/', '?', '#'}) {
            int idx = s.indexOf(c);
            if (idx >= 0 && idx < cut) {
                cut = idx;
            }
        }
        s = s.substring(0, cut);

        int at = s.indexOf('@');
        if (at >= 0) {
            s = s.substring(at + 1);
        }

        int colon = s.indexOf(':');
        if (colon >= 0) {
            s = s.substring(0, colon);
        }

        return s.toLowerCase();
    }
}
