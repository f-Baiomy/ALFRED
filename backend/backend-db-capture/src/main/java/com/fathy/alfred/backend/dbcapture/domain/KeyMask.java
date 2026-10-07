package com.fathy.alfred.backend.dbcapture.domain;

import java.util.List;
import java.util.regex.Pattern;

/**
 * The project's masked key patterns (specs/011-redis-capture FR-032): globs like {@code session:*} or {@code *token*}
 * ({@code *} any run, {@code ?} one character). A masked key keeps its name and size everywhere a value is shown -
 * the window, exports, Claude - and its value becomes {@code ‹masked · n B›}. Stored data is never changed.
 */
public final class KeyMask {

    private final List<Pattern> patterns;

    public KeyMask(List<String> globs) {
        this.patterns = globs == null ? List.of() : globs.stream().filter(g -> g != null && !g.isBlank()).map(KeyMask::compile).toList();
    }

    public static final KeyMask NONE = new KeyMask(List.of());

    public boolean isEmpty() {
        return patterns.isEmpty();
    }

    /** True when any of the command's keys matches a pattern. */
    public boolean masks(List<String> keys) {
        if (patterns.isEmpty() || keys == null) {
            return false;
        }
        for (String k : keys) {
            if (k != null && masks(k)) {
                return true;
            }
        }
        return false;
    }

    public boolean masks(String key) {
        for (Pattern p : patterns) {
            if (p.matcher(key).matches()) {
                return true;
            }
        }
        return false;
    }

    public static String placeholder(long bytes) {
        return "‹masked · " + String.format("%,d", bytes) + " B›";
    }

    private static Pattern compile(String glob) {
        StringBuilder re = new StringBuilder();
        for (char c : glob.trim().toCharArray()) {
            switch (c) {
                case '*' -> re.append(".*");
                case '?' -> re.append('.');
                default -> re.append(Pattern.quote(String.valueOf(c)));
            }
        }
        return Pattern.compile(re.toString(), Pattern.DOTALL);
    }
}
