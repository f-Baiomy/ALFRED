package com.fathy.alfred.backend.logs.domain.ingest;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Reads Java {@code toString()} text such as
 * {@code LoginDTO(email=a@b.c, password=null, displayUserType=AGN1422)} into key/value pairs, so
 * those keys become searchable fields instead of one opaque string (FR-010). Commas inside nested
 * parentheses or brackets do not split a value.
 */
public final class ObjectTextParser {

    private static final Pattern SHAPE = Pattern.compile("^[A-Za-z_$][\\w$.]*\\((.*)\\)$", Pattern.DOTALL);
    private static final Pattern KEY = Pattern.compile("[A-Za-z_$][\\w$]*");

    private ObjectTextParser() {
    }

    /** Empty when the text is not that shape (or has no key=value pair at all). */
    public static Optional<Map<String, String>> parse(String text) {
        if (text == null || text.length() < 4 || text.length() > 1_000_000) {
            return Optional.empty();
        }
        var m = SHAPE.matcher(text.trim());
        if (!m.matches()) {
            return Optional.empty();
        }
        String body = m.group(1);
        Map<String, String> out = new LinkedHashMap<>();
        int depth = 0;
        int start = 0;
        for (int i = 0; i <= body.length(); i++) {
            char c = i < body.length() ? body.charAt(i) : ',';
            if (c == '(' || c == '[' || c == '{') {
                depth++;
            } else if (c == ')' || c == ']' || c == '}') {
                depth--;
            } else if (c == ',' && depth == 0) {
                String part = body.substring(start, i).trim();
                start = i + 1;
                if (part.isEmpty()) {
                    continue;
                }
                int eq = part.indexOf('=');
                if (eq <= 0 || !KEY.matcher(part.substring(0, eq).trim()).matches()) {
                    return Optional.empty();
                }
                out.put(part.substring(0, eq).trim(), part.substring(eq + 1).trim());
            }
        }
        return out.isEmpty() ? Optional.empty() : Optional.of(out);
    }
}
