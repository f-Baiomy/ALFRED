package com.fathy.alfred.backend.server.domain.model;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * The .env file as an ordered list of lines, so an edit changes only the lines it must (FR-015): comments, blank lines,
 * line order, unknown lines and the file's line endings all survive a round trip byte for byte. Immutable - every edit
 * returns a new document.
 *
 * <p>Reading follows alfred_settings.read_env_file: "KEY=value", whitespace around key and value ignored, a later
 * line for the same key wins. A line that is not a comment, not blank and not KEY=value is kept as {@link Unknown}
 * and reported with its line number (FR-016) rather than dropped.
 */
public final class EnvDocument {

    private static final Pattern KEY = Pattern.compile("^[A-Za-z_][A-Za-z0-9_]*$");

    public sealed interface Line permits Comment, Blank, Entry, Unknown {
        String text();
    }

    public record Comment(String text) implements Line {
    }

    public record Blank(String text) implements Line {
    }

    public record Entry(String key, String value, String text) implements Line {
        static Entry of(String key, String value) {
            return new Entry(key, value, key + "=" + value);
        }
    }

    /** @param lineNumber 1-based, as the file was read */
    public record Unknown(int lineNumber, String text) implements Line {
    }

    private final List<Line> lines;
    private final String newline;
    private final boolean endsWithNewline;
    private final String contentHash;

    private EnvDocument(List<Line> lines, String newline, boolean endsWithNewline, String contentHash) {
        this.lines = List.copyOf(lines);
        this.newline = newline;
        this.endsWithNewline = endsWithNewline;
        this.contentHash = contentHash;
    }

    public static EnvDocument empty() {
        return parse("");
    }

    public static EnvDocument parse(String content) {
        String text = content == null ? "" : content;
        String newline = text.contains("\r\n") ? "\r\n" : "\n";
        boolean endsWithNewline = text.endsWith("\n");
        String body = endsWithNewline ? text.substring(0, text.length() - (text.endsWith("\r\n") ? 2 : 1)) : text;
        List<Line> lines = new ArrayList<>();
        if (!text.isEmpty()) {
            String[] raw = body.split("\r?\n", -1);
            for (int i = 0; i < raw.length; i++) {
                lines.add(classify(raw[i], i + 1));
            }
        }
        return new EnvDocument(lines, newline, endsWithNewline || text.isEmpty(), hash(text));
    }

    private static Line classify(String text, int lineNumber) {
        String stripped = text.strip();
        if (stripped.isEmpty()) {
            return new Blank(text);
        }
        if (stripped.startsWith("#")) {
            return new Comment(text);
        }
        int eq = stripped.indexOf('=');
        if (eq > 0) {
            String key = stripped.substring(0, eq).strip();
            if (KEY.matcher(key).matches()) {
                return new Entry(key, stripped.substring(eq + 1).strip(), text);
            }
        }
        return new Unknown(lineNumber, text);
    }

    public List<Line> lines() {
        return lines;
    }

    /** SHA-256 of the file as it was read: an editor sends it back so a save can detect a change underneath (FR-036). */
    public String contentHash() {
        return contentHash;
    }

    public Optional<String> get(String key) {
        String value = null;
        for (Line line : lines) {
            if (line instanceof Entry entry && entry.key().equals(key)) {
                value = entry.value();
            }
        }
        return Optional.ofNullable(value);
    }

    /** Every KEY=value, later lines winning, in first-seen order. */
    public Map<String, String> entries() {
        Map<String, String> map = new LinkedHashMap<>();
        for (Line line : lines) {
            if (line instanceof Entry entry) {
                map.put(entry.key(), entry.value());
            }
        }
        return map;
    }

    public List<Unknown> unknownLines() {
        return lines.stream().filter(Unknown.class::isInstance).map(Unknown.class::cast).toList();
    }

    /**
     * Sets {@code key}: every existing line for it is rewritten in place (normally there is one). A new key goes at
     * the end of its group's section - the lines after {@code groupHeader} up to the next "# ---" header - and the
     * header is created at the end of the file when missing.
     */
    public EnvDocument set(String key, String value, String groupHeader) {
        List<Line> next = new ArrayList<>(lines);
        boolean found = false;
        for (int i = 0; i < next.size(); i++) {
            if (next.get(i) instanceof Entry entry && entry.key().equals(key)) {
                next.set(i, Entry.of(key, value));
                found = true;
            }
        }
        if (!found) {
            insertUnderHeader(next, Entry.of(key, value), groupHeader);
        }
        return new EnvDocument(next, newline, endsWithNewline, contentHash);
    }

    /** Removes every line for {@code key}; its default from settings.properties applies again. */
    public EnvDocument remove(String key) {
        List<Line> next = new ArrayList<>(lines);
        next.removeIf(line -> line instanceof Entry entry && entry.key().equals(key));
        return new EnvDocument(next, newline, endsWithNewline, contentHash);
    }

    /** Appends lines as they are (used to build a new file from the catalog). */
    public EnvDocument append(List<String> texts) {
        List<Line> next = new ArrayList<>(lines);
        for (String text : texts) {
            next.add(classify(text, next.size() + 1));
        }
        return new EnvDocument(next, newline, true, contentHash);
    }

    public String render() {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < lines.size(); i++) {
            out.append(lines.get(i).text());
            if (i < lines.size() - 1 || endsWithNewline) {
                out.append(newline);
            }
        }
        return out.toString();
    }

    private static void insertUnderHeader(List<Line> lines, Entry entry, String groupHeader) {
        int header = -1;
        for (int i = 0; i < lines.size(); i++) {
            if (lines.get(i) instanceof Comment comment && comment.text().strip().equals(groupHeader.strip())) {
                header = i;
                break;
            }
        }
        if (header < 0) {
            if (!lines.isEmpty() && !(lines.get(lines.size() - 1) instanceof Blank)) {
                lines.add(new Blank(""));
            }
            lines.add(new Comment(groupHeader));
            lines.add(entry);
            return;
        }
        int end = lines.size();
        for (int i = header + 1; i < lines.size(); i++) {
            if (lines.get(i) instanceof Comment comment && comment.text().strip().startsWith("# ---")) {
                end = i;
                break;
            }
        }
        while (end > header + 1 && lines.get(end - 1) instanceof Blank) {
            end--;
        }
        lines.add(end, entry);
    }

    /** SHA-256 of arbitrary file content, computed the same way as {@link #contentHash()}. */
    public static String hashOf(String content) {
        return hash(content == null ? "" : content);
    }

    private static String hash(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is part of every JDK", e);
        }
    }
}
