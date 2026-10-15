package com.fathy.alfred.backend.board.domain;

import java.util.Locale;

/**
 * Whether a call's endpoint is the one an item's evidence names (specs/018). Both are {@code METHOD /path}; a path
 * segment that is a placeholder on either side ({@code {n}}, {@code {x}}, {@code :id}, {@code *}) or an id-like value
 * (digits, a UUID, letters and digits mixed - {@code Booking2}) matches any segment, so evidence written as
 * {@code POST /odeysysadmin/Booking2/refunded-requests/search} matches triage's
 * {@code POST /odeysysadmin/{x}/refunded-requests/search} and the other way round. Literal segments compare case-blind.
 */
public final class EndpointPattern {

    private EndpointPattern() {
    }

    public static boolean matches(String evidence, String call) {
        if (evidence == null || call == null) {
            return false;
        }
        String[] a = evidence.strip().split("\\s+", 2);
        String[] b = call.strip().split("\\s+", 2);
        if (a.length != 2 || b.length != 2 || !a[0].equalsIgnoreCase(b[0])) {
            return false;
        }
        String[] x = segments(a[1]);
        String[] y = segments(b[1]);
        if (x.length != y.length) {
            return false;
        }
        for (int i = 0; i < x.length; i++) {
            if (!(wild(x[i]) || wild(y[i]) || x[i].equalsIgnoreCase(y[i]))) {
                return false;
            }
        }
        return true;
    }

    private static String[] segments(String path) {
        String p = path;
        int q = p.indexOf('?');
        if (q >= 0) {
            p = p.substring(0, q);
        }
        p = p.replaceAll("^/+|/+$", "");
        return p.isEmpty() ? new String[0] : p.split("/+");
    }

    static boolean wild(String s) {
        String t = s.toLowerCase(Locale.ROOT);
        return t.equals("*") || t.startsWith(":") || (t.startsWith("{") && t.endsWith("}"))
                || t.matches("\\d+") || t.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
                || (t.length() >= 4 && t.matches("[a-z0-9_]+") && t.matches(".*\\d.*") && t.matches(".*[a-z].*"));
    }
}
