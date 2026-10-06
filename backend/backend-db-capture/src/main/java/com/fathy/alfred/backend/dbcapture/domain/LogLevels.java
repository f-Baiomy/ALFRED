package com.fathy.alfred.backend.dbcapture.domain;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Log level names on one scale, as the frameworks spell them (specs/010-mcp-log-investigation): ERROR includes FATAL
 * and SEVERE, WARN includes WARNING, INFO includes CONFIG, DEBUG includes FINE, TRACE includes FINER and FINEST.
 */
public final class LogLevels {

    private static final List<List<String>> SCALE = List.of(List.of("FATAL", "ERROR", "SEVERE"), List.of("WARN", "WARNING"),
            List.of("INFO", "CONFIG"), List.of("DEBUG", "FINE"), List.of("TRACE", "FINER", "FINEST"));

    private LogLevels() {
    }

    /** Every spelling at or above {@code minLevel} (upper case); null for none asked. Unknown names are refused. */
    public static List<String> atOrAbove(String minLevel) {
        if (minLevel == null || minLevel.isBlank()) {
            return null;
        }
        String wanted = minLevel.strip().toUpperCase(Locale.ROOT);
        List<String> out = new ArrayList<>();
        for (List<String> rank : SCALE) {
            out.addAll(rank);
            if (rank.contains(wanted)) {
                return List.copyOf(out);
            }
        }
        throw new IllegalArgumentException("unknown level: " + minLevel + " (ERROR, WARN, INFO, DEBUG or TRACE)");
    }
}
