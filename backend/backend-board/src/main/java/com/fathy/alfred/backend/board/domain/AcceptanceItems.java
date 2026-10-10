package com.fathy.alfred.backend.board.domain;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The acceptance items of a spec file: list items directly under the first heading that contains "acceptance", up to
 * the next heading of the same or a higher level (research R13). An item's key is the SHA-256 of its normalized text,
 * so a mark survives a replace that leaves the item unchanged. Cases in specs/014-task-board/vectors/acceptance-items.json,
 * shared with acceptance-items.ts.
 */
public final class AcceptanceItems {

    private static final Pattern HEADING = Pattern.compile("^(#{1,6})\\s+(.*)$");
    private static final Pattern ITEM = Pattern.compile("^([-*+]|\\d+[.)])\\s+(.*)$");

    /** One item: its text and key. */
    public record Item(String key, String text) {
    }

    private AcceptanceItems() {
    }

    public static List<Item> of(String content) {
        List<Item> items = new ArrayList<>();
        if (content == null) {
            return items;
        }
        int level = -1;
        for (String raw : content.split("\r?\n", -1)) {
            String line = raw.replace("\r", "");
            Matcher heading = HEADING.matcher(line.strip());
            if (heading.matches() && !Character.isWhitespace(line.isEmpty() ? 'x' : line.charAt(0))) {
                int depth = heading.group(1).length();
                if (level < 0) {
                    if (heading.group(2).toLowerCase(Locale.ROOT).contains("acceptance")) {
                        level = depth;
                    }
                } else if (depth <= level) {
                    break;
                }
                continue;
            }
            if (level < 0 || line.isEmpty() || Character.isWhitespace(line.charAt(0))) {
                continue;
            }
            Matcher item = ITEM.matcher(line);
            if (item.matches()) {
                String text = normalize(item.group(2));
                if (!text.isEmpty()) {
                    items.add(new Item(key(text), text));
                }
            }
        }
        return items;
    }

    public static String normalize(String text) {
        return text.strip().replaceAll("\\s+", " ");
    }

    public static String key(String text) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(normalize(text).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is always present", e);
        }
    }
}
