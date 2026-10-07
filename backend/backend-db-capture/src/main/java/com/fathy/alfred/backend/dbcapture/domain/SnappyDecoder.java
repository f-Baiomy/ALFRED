package com.fathy.alfred.backend.dbcapture.domain;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * Snappy, raw and framed (specs/011-redis-capture research R11) - the format is small enough to read here rather than
 * add a native library. Output is bounded by {@code maxBytes}: a value claiming more is refused (null), never inflated
 * past the limit. Returns null for anything that is not valid Snappy.
 */
public final class SnappyDecoder {

    private static final byte[] FRAMED_MAGIC = {(byte) 0xff, 0x06, 0x00, 0x00, 's', 'N', 'a', 'P', 'p', 'Y'};

    private SnappyDecoder() {
    }

    public static boolean framed(byte[] in) {
        return in != null && in.length >= FRAMED_MAGIC.length && Arrays.equals(Arrays.copyOf(in, FRAMED_MAGIC.length), FRAMED_MAGIC);
    }

    /** Framed stream: identifier, then compressed (0x00) / uncompressed (0x01) chunks, each with a 4-byte CRC first. */
    public static byte[] decodeFramed(byte[] in, long maxBytes) {
        if (!framed(in)) {
            return null;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int pos = FRAMED_MAGIC.length;
        while (pos + 4 <= in.length) {
            int type = in[pos] & 0xff;
            int len = (in[pos + 1] & 0xff) | (in[pos + 2] & 0xff) << 8 | (in[pos + 3] & 0xff) << 16;
            pos += 4;
            if (pos + len > in.length) {
                return null;
            }
            if (type == 0x00 || type == 0x01) {
                if (len < 4) {
                    return null;
                }
                byte[] body = Arrays.copyOfRange(in, pos + 4, pos + len);
                byte[] data = type == 0x00 ? decodeRaw(body, maxBytes - out.size()) : body;
                if (data == null || out.size() + data.length > maxBytes) {
                    return null;
                }
                out.write(data, 0, data.length);
            } else if (type < 0x80 && type != 0xff) {
                return null; // reserved unskippable chunk
            }
            pos += len;
        }
        return pos == in.length ? out.toByteArray() : null;
    }

    /** Raw block: the uncompressed length as a varint, then literals and back-references. */
    public static byte[] decodeRaw(byte[] in, long maxBytes) {
        if (in == null || in.length == 0) {
            return null;
        }
        int[] pos = {0};
        long length = varint(in, pos);
        if (length < 0 || length > maxBytes || length > Integer.MAX_VALUE - 8) {
            return null;
        }
        byte[] out = new byte[(int) length];
        int o = 0;
        while (pos[0] < in.length) {
            int tag = in[pos[0]++] & 0xff;
            int kind = tag & 3;
            if (kind == 0) {
                int len = tag >>> 2;
                if (len >= 60) {
                    int extra = len - 59;
                    if (pos[0] + extra > in.length) {
                        return null;
                    }
                    len = 0;
                    for (int i = 0; i < extra; i++) {
                        len |= (in[pos[0]++] & 0xff) << (8 * i);
                    }
                }
                len += 1;
                if (len < 0 || pos[0] + len > in.length || o + len > out.length) {
                    return null;
                }
                System.arraycopy(in, pos[0], out, o, len);
                pos[0] += len;
                o += len;
            } else {
                int len;
                int offset;
                if (kind == 1) {
                    if (pos[0] >= in.length) {
                        return null;
                    }
                    len = 4 + ((tag >>> 2) & 7);
                    offset = ((tag >>> 5) << 8) | (in[pos[0]++] & 0xff);
                } else if (kind == 2) {
                    if (pos[0] + 2 > in.length) {
                        return null;
                    }
                    len = 1 + (tag >>> 2);
                    offset = (in[pos[0]] & 0xff) | (in[pos[0] + 1] & 0xff) << 8;
                    pos[0] += 2;
                } else {
                    if (pos[0] + 4 > in.length) {
                        return null;
                    }
                    len = 1 + (tag >>> 2);
                    offset = (in[pos[0]] & 0xff) | (in[pos[0] + 1] & 0xff) << 8 | (in[pos[0] + 2] & 0xff) << 16 | (in[pos[0] + 3] & 0xff) << 24;
                    pos[0] += 4;
                }
                if (offset <= 0 || offset > o || o + len > out.length) {
                    return null;
                }
                for (int i = 0; i < len; i++) {
                    out[o + i] = out[o - offset + i];
                }
                o += len;
            }
        }
        return o == out.length ? out : null;
    }

    private static long varint(byte[] in, int[] pos) {
        long v = 0;
        for (int shift = 0; shift < 35; shift += 7) {
            if (pos[0] >= in.length) {
                return -1;
            }
            int b = in[pos[0]++] & 0xff;
            v |= (long) (b & 0x7f) << shift;
            if ((b & 0x80) == 0) {
                return v;
            }
        }
        return -1;
    }

    /** Snappy-compresses {@code data} as literals only - for tests that need a valid stream without a library. */
    public static byte[] literalOnly(byte[] data) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        long n = data.length;
        do {
            int b = (int) (n & 0x7f);
            n >>>= 7;
            out.write(n == 0 ? b : b | 0x80);
        } while (n != 0);
        int pos = 0;
        while (pos < data.length) {
            int len = Math.min(65536, data.length - pos);
            int l = len - 1;
            if (l < 60) {
                out.write(l << 2);
            } else if (l < 256) {
                out.write(60 << 2);
                out.write(l);
            } else {
                out.write(61 << 2);
                out.write(l & 0xff);
                out.write(l >>> 8);
            }
            out.write(data, pos, len);
            pos += len;
        }
        return out.toByteArray();
    }

    static String ascii(byte[] b) {
        return new String(b, StandardCharsets.ISO_8859_1);
    }
}
