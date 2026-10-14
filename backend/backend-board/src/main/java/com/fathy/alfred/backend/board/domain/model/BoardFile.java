package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.util.Locale;
import java.util.Map;

/**
 * A file attached to a card or a cycle (specs/017 R36): a CSV, a log, a HAR, a PDF... kept in Alfred with the card and
 * going with it. Snippets read it (alfred.files), Claude reads it in parts. {@code data} is null in lists.
 */
public record BoardFile(String id, String project, String cardId, String cycleId, String name, String mime, long size, byte[] data,
                        Actor author, Instant createdAt) {

    public static final int MAX_BYTES = 10 * 1024 * 1024;
    public static final int MAX_PER_OWNER = 50;
    public static final int MAX_NAME = 120;

    /** The extensions a file may have, and the type each is kept and served as. Anything else is refused. */
    public static final Map<String, String> TYPES = Map.ofEntries(
            Map.entry("csv", "text/csv"), Map.entry("json", "application/json"), Map.entry("txt", "text/plain"),
            Map.entry("log", "text/plain"), Map.entry("har", "application/json"), Map.entry("xml", "application/xml"),
            Map.entry("sql", "text/plain"), Map.entry("md", "text/markdown"), Map.entry("pdf", "application/pdf"),
            Map.entry("png", "image/png"), Map.entry("jpg", "image/jpeg"), Map.entry("jpeg", "image/jpeg"));

    public static String extension(String name) {
        int dot = name == null ? -1 : name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    /** Text a snippet or Claude can read as it is (the rest are read as bytes). */
    public boolean isText() {
        return mime.startsWith("text/") || mime.equals("application/json") || mime.equals("application/xml");
    }

    public BoardFile withoutData() {
        return new BoardFile(id, project, cardId, cycleId, name, mime, size, null, author, createdAt);
    }
}
