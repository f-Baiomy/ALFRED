package com.fathy.alfred.backend.dbcapture.domain;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * A best-effort reading of a Kryo value as Kryo's FieldSerializer writes it (specs/011-redis-capture research R11): a
 * class id (registered classes - only a number, so the class shows as {@code class #n}) or the class name (unregistered
 * classes), then the field values in order with no names - strings (ASCII with the last byte flagged, or a flagged
 * length and UTF-8) and variable-length numbers. Never claims more than it can read: always partial, and null when the
 * bytes do not read as Kryo at all.
 */
public final class KryoReader {

    static final int MAX_FIELDS = 512;

    private KryoReader() {
    }

    public record Result(String className, String text) {
    }

    public static Result read(byte[] b) {
        if (b == null || b.length < 2) {
            return null;
        }
        try {
            int[] pos = {0};
            String cls;
            int first = b[0] & 0xff;
            if (first == 1) { // NAME: an unregistered class, its name follows
                pos[0] = 1;
                long nameId = varint(b, pos); // the name's own id (Kryo writes it before the name the first time)
                String name = ascii(b, pos);
                if (name == null || !name.matches("[A-Za-z_$][\\w$.]*")) {
                    return null;
                }
                cls = name;
                if (nameId < 0) {
                    return null;
                }
            } else if (first >= 2 && first < 0x80) {
                pos[0] = 1;
                cls = "class #" + (first - 2);
            } else {
                return null;
            }
            List<String> fields = new ArrayList<>();
            int strings = 0;
            while (pos[0] < b.length && fields.size() < MAX_FIELDS) {
                int start = pos[0];
                String s = ascii(b, pos);
                if (s != null && s.length() >= 1) {
                    fields.add("\"" + s + "\"");
                    strings++;
                    continue;
                }
                pos[0] = start;
                int head = b[pos[0]] & 0xff;
                if (head == 0x00) {
                    pos[0]++;
                    fields.add("null");
                    continue;
                }
                if ((head & 0x80) != 0 && (head & 0x40) == 0) {
                    String u = utf8String(b, pos);
                    if (u != null) {
                        fields.add("\"" + u + "\"");
                        strings++;
                        continue;
                    }
                    pos[0] = start;
                }
                long v = varint(b, pos);
                if (v < 0) {
                    break;
                }
                fields.add(String.valueOf(v));
            }
            if (fields.isEmpty() || (strings == 0 && fields.size() < 2)) {
                return null;
            }
            StringBuilder out = new StringBuilder(cls).append(" {");
            for (int i = 0; i < fields.size(); i++) {
                out.append("\n  field ").append(i + 1).append(": ").append(fields.get(i));
            }
            if (pos[0] < b.length) {
                out.append("\n  … ").append(b.length - pos[0]).append(" more bytes not read");
            }
            return new Result(cls.startsWith("class #") ? null : cls, out.append("\n}").toString());
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Kryo's ASCII string: printable bytes, the last one with its high bit set. Null when not one. */
    private static String ascii(byte[] b, int[] pos) {
        StringBuilder s = new StringBuilder();
        for (int i = pos[0]; i < b.length && i - pos[0] < 65536; i++) {
            int c = b[i] & 0xff;
            int ch = c & 0x7f;
            if (ch < 0x20 || ch == 0x7f) {
                return null;
            }
            s.append((char) ch);
            if ((c & 0x80) != 0) {
                if (s.length() < 2 && !Character.isLetterOrDigit(ch)) {
                    return null;
                }
                pos[0] = i + 1;
                return s.toString();
            }
        }
        return null;
    }

    /** Kryo's UTF-8 string: a varint length+1 whose first byte is flagged 0x80, then the characters. */
    private static String utf8String(byte[] b, int[] pos) {
        int first = b[pos[0]++] & 0xff;
        long len = first & 0x3f;
        if ((first & 0x40) != 0) {
            return null;
        }
        if (len == 0) {
            return null;
        }
        len -= 1;
        if (len <= 0 || pos[0] + len > b.length) {
            return null;
        }
        String s = new String(b, pos[0], (int) len, StandardCharsets.UTF_8);
        if (Resp.utf8(java.util.Arrays.copyOfRange(b, pos[0], (int) (pos[0] + len))) == null) {
            return null;
        }
        pos[0] += (int) len;
        return s;
    }

    private static long varint(byte[] b, int[] pos) {
        long v = 0;
        for (int shift = 0; shift < 64; shift += 7) {
            if (pos[0] >= b.length) {
                return -1;
            }
            int c = b[pos[0]++] & 0xff;
            v |= (long) (c & 0x7f) << shift;
            if ((c & 0x80) == 0) {
                return v;
            }
        }
        return -1;
    }
}
