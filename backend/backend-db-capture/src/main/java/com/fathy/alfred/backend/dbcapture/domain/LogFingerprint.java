package com.fathy.alfred.backend.dbcapture.domain;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Pattern;

/**
 * What a log line means once its varying parts are set aside (specs/010-mcp-log-investigation, research R4) - so the
 * same error logged with different ids, numbers and times is one "log problem". Deliberately conservative: only
 * shapes that are clearly values are replaced, and an unrecognised shape stays literal, so two different errors are
 * never merged. The MCP server holds a port of the same rules, tested against the same vectors
 * (specs/010-mcp-log-investigation/fixtures/fingerprint-vectors.json). Pure.
 */
public final class LogFingerprint {

    /** Characters of the normalised message that take part in the fingerprint. */
    static final int MAX_NORMALISED = 300;

    private record Rule(Pattern pattern, String replacement) {
    }

    /** In order: a quoted value may hold anything, a UUID or a timestamp holds digits a later rule would split. */
    private static final List<Rule> RULES = List.of(
            new Rule(Pattern.compile("'[^'\\n]*'|\"[^\"\\n]*\""), "<q>"),
            new Rule(Pattern.compile("\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b"), "<uuid>"),
            new Rule(Pattern.compile("\\b\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?"), "<ts>"),
            new Rule(Pattern.compile("[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+"), "<email>"),
            new Rule(Pattern.compile("\\b\\d{1,3}(?:\\.\\d{1,3}){3}(?::\\d{1,5})?\\b"), "<ip>"),
            new Rule(Pattern.compile("\\b(?=[0-9a-fA-F]*\\d)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{8,}\\b"), "<hex>"),
            new Rule(Pattern.compile("(?<![\\w.])-?\\d+(?:\\.\\d+)?(?!\\w)"), "<n>"),
            new Rule(Pattern.compile("\\s+"), " "));

    private LogFingerprint() {
    }

    /** The message with its varying parts replaced, whitespace collapsed, cut to 300 characters; "" for none. */
    public static String normalise(String message) {
        if (message == null || message.isEmpty()) {
            return "";
        }
        String out = message;
        for (Rule rule : RULES) {
            out = rule.pattern().matcher(out).replaceAll(rule.replacement());
        }
        out = out.strip();
        return out.length() > MAX_NORMALISED ? out.substring(0, MAX_NORMALISED) : out;
    }

    /** 16 hex characters: the same logger, exception type and normalised message give the same fingerprint. */
    public static String of(String logger, String exceptionType, String message) {
        String key = (logger == null ? "" : logger) + '|' + (exceptionType == null ? "" : exceptionType) + '|' + normalise(message);
        try {
            byte[] digest = MessageDigest.getInstance("SHA-1").digest(key.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest, 0, 8);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-1 is part of every JDK", e);
        }
    }
}
