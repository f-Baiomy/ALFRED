package com.fathy.alfred.backend.board.application.service;

import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Masks prose that leaves Alfred (specs/037, the questions form): the secret variable values, and the shapes a secret takes
 * in text - a bearer token, an Authorization / Cookie / Set-Cookie header, a password-like field, a JWT. The same rules
 * as the MCP server's {@code maskProseWith} (mcp-server/src/masking.ts) and the same marker as every export.
 */
final class ProseMask {

    static final String REDACTED = "***REDACTED***";

    private static final Pattern BEARER = Pattern.compile("\\b(Bearer|Basic)\\s+[A-Za-z0-9._~+/=-]{8,}", Pattern.CASE_INSENSITIVE);
    private static final Pattern HEADER = Pattern.compile("\\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token)(\\s*[:=]\\s*)[^\\r\\n]+",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern FIELD = Pattern.compile(
            "(\"?(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\"?\\s*[:=]\\s*)(\"[^\"]*\"|'[^']*'|[^\\s,;}&]+)",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern JWT = Pattern.compile("\\beyJ[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\b");

    private final List<String> secrets;

    ProseMask(List<String> secretValues) {
        // longest first, so a value that contains another is hidden whole; very short values would mask ordinary words
        this.secrets = (secretValues == null ? List.<String>of() : secretValues).stream()
                .filter(v -> v != null && v.length() >= 4).distinct().sorted(Comparator.comparingInt(String::length).reversed()).toList();
    }

    String mask(String text) {
        if (text == null || text.isEmpty()) {
            return text;
        }
        String out = text;
        for (String s : secrets) {
            out = out.replace(s, REDACTED);
        }
        out = BEARER.matcher(out).replaceAll(m -> Matcher.quoteReplacement(m.group(1) + " " + REDACTED));
        out = HEADER.matcher(out).replaceAll(m -> Matcher.quoteReplacement(m.group(1) + m.group(2) + REDACTED));
        out = FIELD.matcher(out).replaceAll(m -> Matcher.quoteReplacement(m.group(1) + REDACTED));
        return JWT.matcher(out).replaceAll(REDACTED);
    }
}
