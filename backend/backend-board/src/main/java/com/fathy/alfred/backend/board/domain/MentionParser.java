package com.fathy.alfred.backend.board.domain;

import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

/**
 * {@code @[type:ref|label]} inside Markdown (contracts/mention-syntax.md). Anything that does not match the grammar is
 * plain text. The frontend's mention-syntax.ts follows the same rules; both run specs/014-task-board/vectors/mentions.json.
 */
public final class MentionParser {

    public static final int MAX_LABEL = 200;

    /** A piece of text: either plain text or one mention. */
    public record Segment(String text, MentionRef mention) {
    }

    private MentionParser() {
    }

    public static List<Segment> parse(String text) {
        List<Segment> out = new ArrayList<>();
        if (text == null || text.isEmpty()) {
            return out;
        }
        StringBuilder plain = new StringBuilder();
        int i = 0;
        while (i < text.length()) {
            if (text.startsWith("@[", i)) {
                Parsed parsed = tryParse(text, i);
                if (parsed != null) {
                    if (!plain.isEmpty()) {
                        out.add(new Segment(plain.toString(), null));
                        plain.setLength(0);
                    }
                    out.add(new Segment(null, parsed.ref));
                    i = parsed.end;
                    continue;
                }
            }
            plain.append(text.charAt(i));
            i++;
        }
        if (!plain.isEmpty()) {
            out.add(new Segment(plain.toString(), null));
        }
        return out;
    }

    /** Every mention in the text, first occurrence kept, in order. */
    public static List<MentionRef> mentions(String text) {
        LinkedHashSet<MentionRef> refs = new LinkedHashSet<>();
        for (Segment s : parse(text)) {
            if (s.mention() != null) {
                refs.add(s.mention());
            }
        }
        return List.copyOf(refs);
    }

    public static String serialize(MentionRef ref) {
        String label = ref.label().replace('\r', ' ').replace('\n', ' ').replace("|", "\\|").replace("]", "\\]");
        return "@[" + ref.typeName() + ":" + ref.ref() + "|" + label + "]";
    }

    /** Heading text to the slug a spec mention's {@code #section} uses. */
    public static String slug(String heading) {
        String lower = heading.toLowerCase(Locale.ROOT);
        StringBuilder out = new StringBuilder();
        boolean dash = false;
        for (int i = 0; i < lower.length(); i++) {
            char c = lower.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
                out.append(c);
                dash = false;
            } else if (!dash && !out.isEmpty()) {
                out.append('-');
                dash = true;
            }
        }
        int end = out.length();
        while (end > 0 && out.charAt(end - 1) == '-') {
            end--;
        }
        return out.substring(0, end);
    }

    private record Parsed(MentionRef ref, int end) {
    }

    private static Parsed tryParse(String text, int start) {
        int colon = text.indexOf(':', start + 2);
        if (colon < 0) {
            return null;
        }
        String typeName = text.substring(start + 2, colon);
        MentionType type = typeOf(typeName);
        if (type == null) {
            return null;
        }
        int pipe = -1;
        for (int i = colon + 1; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '|') {
                pipe = i;
                break;
            }
            if (c == ']' || c == '\n' || c == '\r') {
                return null;
            }
        }
        if (pipe < 0 || pipe == colon + 1) {
            return null;
        }
        String ref = text.substring(colon + 1, pipe);
        StringBuilder label = new StringBuilder();
        for (int i = pipe + 1; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\\' && i + 1 < text.length() && (text.charAt(i + 1) == '|' || text.charAt(i + 1) == ']')) {
                label.append(text.charAt(i + 1));
                i++;
                continue;
            }
            if (c == '\n' || c == '\r' || c == '|') {
                return null;
            }
            if (c == ']') {
                if (label.isEmpty() || label.length() > MAX_LABEL) {
                    return null;
                }
                return new Parsed(new MentionRef(type, ref, label.toString()), i + 1);
            }
            label.append(c);
        }
        return null;
    }

    private static MentionType typeOf(String name) {
        if (name.isEmpty() || !name.equals(name.toLowerCase(Locale.ROOT))) {
            return null;
        }
        for (MentionType t : MentionType.values()) {
            if (t.name().toLowerCase(Locale.ROOT).equals(name)) {
                return t;
            }
        }
        return null;
    }
}
