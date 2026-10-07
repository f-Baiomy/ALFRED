package com.fathy.alfred.backend.dbcapture.domain;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Reading the Redis wire format (RESP 2/3) that agents store byte for byte (specs/011-redis-capture research R3) - a
 * reply's type, its error text, a request's arguments, a reply's elements and a readable preview. Pure; the agent has
 * its own writer/reader of the same bytes and both are tested against specs/011-redis-capture/fixtures/resp-cases.json.
 */
public final class Resp {

    private Resp() {
    }

    /** A parsed RESP value: its type marker, its scalar bytes (bulk/simple/number text) or its elements. */
    public record Value(char type, byte[] scalar, List<Value> elements, boolean nil) {

        public boolean isAggregate() {
            return elements != null;
        }
    }

    /** The top-level type name (data-model.md replyType); NONE for no bytes. */
    public static String type(byte[] reply) {
        if (reply == null || reply.length == 0) {
            return "NONE";
        }
        Value v = parse(reply);
        if (v == null) {
            return "NONE";
        }
        return switch (v.type()) {
            case '+' -> "SIMPLE";
            case '-', '!' -> "ERROR";
            case ':' -> "INTEGER";
            case '$' -> v.nil() ? "NIL" : "BULK";
            case '*' -> v.nil() ? "NIL_ARRAY" : "ARRAY";
            case '%' -> "MAP";
            case '~' -> "SET";
            case ',' -> "DOUBLE";
            case '#' -> "BOOLEAN";
            case '(' -> "BIG_NUMBER";
            case '=' -> "VERBATIM";
            case '>' -> "PUSH";
            case '_' -> "NIL";
            default -> "NONE";
        };
    }

    public static int version(byte[] reply) {
        return reply == null || reply.length == 0 ? 2 : "%~,#(=>_!|".indexOf(reply[0]) >= 0 ? 3 : 2;
    }

    /** The text of an error reply, else null. */
    public static String errorText(byte[] reply) {
        Value v = parse(reply);
        return v != null && (v.type() == '-' || v.type() == '!') ? new String(v.scalar(), StandardCharsets.UTF_8) : null;
    }

    /** The arguments of a request (an array of bulk strings), or an empty list when the bytes are not one. */
    public static List<byte[]> args(byte[] request) {
        Value v = parse(request);
        if (v == null || v.type() != '*' || v.elements() == null) {
            return List.of();
        }
        List<byte[]> out = new ArrayList<>(v.elements().size());
        for (Value e : v.elements()) {
            out.add(e.scalar() == null ? new byte[0] : e.scalar());
        }
        return out;
    }

    /** Parses one value (an attribute frame is skipped); null when malformed or incomplete. */
    public static Value parse(byte[] b) {
        if (b == null || b.length == 0) {
            return null;
        }
        int[] pos = {0};
        Value v = read(b, pos);
        if (v != null && v.type() == '|') {
            v = read(b, pos);
        }
        return v;
    }

    private static Value read(byte[] b, int[] pos) {
        if (pos[0] >= b.length) {
            return null;
        }
        char t = (char) b[pos[0]++];
        switch (t) {
            case '+', '-', ':', ',', '#', '(' -> {
                int end = crlf(b, pos[0]);
                if (end < 0) {
                    return null;
                }
                byte[] s = Arrays.copyOfRange(b, pos[0], end);
                pos[0] = end + 2;
                return new Value(t, s, null, false);
            }
            case '_' -> {
                pos[0] += 2;
                return new Value(t, null, null, true);
            }
            case '$', '!', '=' -> {
                long len = number(b, pos);
                if (len == Long.MIN_VALUE) {
                    return null;
                }
                if (len < 0) {
                    return new Value(t, null, null, true);
                }
                if (pos[0] + len + 2 > b.length) {
                    return null;
                }
                byte[] s = Arrays.copyOfRange(b, pos[0], (int) (pos[0] + len));
                pos[0] += (int) len + 2;
                return new Value(t, s, null, false);
            }
            case '*', '~', '>', '%', '|' -> {
                long n = number(b, pos);
                if (n == Long.MIN_VALUE) {
                    return null;
                }
                if (n < 0) {
                    return new Value(t, null, null, true);
                }
                long items = (t == '%' || t == '|') ? n * 2 : n;
                List<Value> elements = new ArrayList<>((int) Math.min(items, 4096));
                for (long i = 0; i < items; i++) {
                    Value e = read(b, pos);
                    if (e == null) {
                        return null;
                    }
                    elements.add(e);
                }
                return new Value(t, null, elements, false);
            }
            default -> {
                return null;
            }
        }
    }

    private static int crlf(byte[] b, int from) {
        for (int i = from; i + 1 < b.length; i++) {
            if (b[i] == '\r' && b[i + 1] == '\n') {
                return i;
            }
        }
        return -1;
    }

    private static long number(byte[] b, int[] pos) {
        int end = crlf(b, pos[0]);
        if (end < 0) {
            return Long.MIN_VALUE;
        }
        try {
            long v = Long.parseLong(new String(b, pos[0], end - pos[0], StandardCharsets.US_ASCII));
            pos[0] = end + 2;
            return v;
        } catch (NumberFormatException e) {
            return Long.MIN_VALUE;
        }
    }

    /** True for a read's empty answer: nil, a nil array, or an empty array/map/set. */
    public static boolean empty(byte[] reply) {
        Value v = parse(reply);
        if (v == null) {
            return false;
        }
        if (v.nil()) {
            return true;
        }
        return v.isAggregate() && v.elements().isEmpty();
    }

    /** The value bytes a reply carries - a bulk string's bytes, else the reply as given (for hashing and decoding). */
    public static byte[] valueBytes(byte[] reply) {
        Value v = parse(reply);
        if (v != null && !v.isAggregate() && v.scalar() != null && (v.type() == '$' || v.type() == '=')) {
            return v.type() == '=' && v.scalar().length > 4 ? Arrays.copyOfRange(v.scalar(), 4, v.scalar().length) : v.scalar();
        }
        return reply;
    }

    /** A readable one-line rendering of a reply, at most {@code max} characters (binary bulk → {@code ‹binary n B›}). */
    public static String preview(byte[] reply, int max) {
        Value v = parse(reply);
        if (v == null) {
            return reply == null || reply.length == 0 ? "" : "‹" + reply.length + " B›";
        }
        StringBuilder out = new StringBuilder();
        render(v, out, max, true);
        return out.length() > max ? out.substring(0, max - 1) + "…" : out.toString();
    }

    private static void render(Value v, StringBuilder out, int max, boolean top) {
        if (out.length() > max) {
            return;
        }
        if (v.nil()) {
            out.append("(nil)");
            return;
        }
        if (v.isAggregate()) {
            if (top) {
                int n = v.type() == '%' ? v.elements().size() / 2 : v.elements().size();
                out.append(v.type() == '%' ? n + (n == 1 ? " field" : " fields") : n + (n == 1 ? " element" : " elements"));
                return;
            }
            out.append('[');
            for (int i = 0; i < v.elements().size() && out.length() <= max; i++) {
                if (i > 0) {
                    out.append(", ");
                }
                render(v.elements().get(i), out, max, false);
            }
            out.append(']');
            return;
        }
        switch (v.type()) {
            case ':' -> out.append("(integer) ").append(new String(v.scalar(), StandardCharsets.US_ASCII));
            case '+' -> out.append(new String(v.scalar(), StandardCharsets.UTF_8));
            case '-', '!' -> out.append("ERR ").append(new String(v.scalar(), StandardCharsets.UTF_8));
            default -> {
                String text = utf8(v.scalar());
                out.append(text == null ? "‹binary " + v.scalar().length + " B›" : text.replace('\n', ' '));
            }
        }
    }

    /** UTF-8 text when the bytes are valid UTF-8 without control characters (tabs/newlines allowed), else null. */
    public static String utf8(byte[] b) {
        if (b == null) {
            return null;
        }
        try {
            String s = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(b)).toString();
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c < 0x20 && c != '\t' && c != '\n' && c != '\r') {
                    return null;
                }
            }
            return s;
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    /** Bytes as text: UTF-8 when clean, otherwise printable ASCII with {@code \xNN} escapes (keys, redis-cli). */
    public static String escaped(byte[] b) {
        String s = utf8(b);
        if (s != null && s.indexOf('\n') < 0 && s.indexOf('\r') < 0) {
            return s;
        }
        StringBuilder out = new StringBuilder(b.length * 2);
        for (byte x : b) {
            int c = x & 0xff;
            if (c >= 0x20 && c < 0x7f && c != '\\' && c != '"') {
                out.append((char) c);
            } else {
                out.append(String.format("\\x%02x", c));
            }
        }
        return out.toString();
    }
}
