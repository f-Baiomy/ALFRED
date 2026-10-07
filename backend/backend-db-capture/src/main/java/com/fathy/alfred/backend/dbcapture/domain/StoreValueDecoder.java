package com.fathy.alfred.backend.dbcapture.domain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fathy.alfred.backend.dbcapture.domain.model.DecodedValue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.zip.GZIPInputStream;
import java.util.zip.InflaterInputStream;

/**
 * A stored value as a person reads it (specs/011-redis-capture FR-023, research R11, clarification Q4) - done in ALFRED,
 * only when a value is shown, by reading the bytes as a structure: gzip / zlib / Snappy unpacked (at most 64 MB, a
 * zip-bomb guard), then JDK serialization (read without creating objects), JSON (Spring's {@code @class} hints named),
 * Kryo (best effort), UTF-8 text - else raw bytes. Never at ingest, never in the application, never changes storage.
 */
public final class StoreValueDecoder {

    /** Unpacked output beyond this is not unpacked for display (the value stays stored whole). */
    public static final long MAX_UNPACKED = 64L * 1024 * 1024;
    /** Raw bytes are shown as hex up to this many bytes, then summarised (the full bytes come with "Raw bytes"). */
    static final int HEX_PREVIEW = 4096;

    private static final ObjectMapper JSON = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);

    private StoreValueDecoder() {
    }

    public static DecodedValue decode(byte[] value) {
        if (value == null) {
            return null;
        }
        String packing = null;
        byte[] inner = value;
        try {
            if (gzip(value)) {
                inner = unpack(new GZIPInputStream(new ByteArrayInputStream(value)));
                packing = "gzip";
            } else if (zlib(value)) {
                inner = unpack(new InflaterInputStream(new ByteArrayInputStream(value)));
                packing = "zlib";
            } else if (SnappyDecoder.framed(value)) {
                inner = SnappyDecoder.decodeFramed(value, MAX_UNPACKED);
                packing = inner == null ? null : "Snappy";
                inner = inner == null ? value : inner;
            }
        } catch (TooBig e) {
            return new DecodedValue(packingFormat(gzip(value) ? "gzip" : "zlib", value.length, -1) + " - too large to unpack for display",
                    null, hex(value), true, false, value.length, null);
        } catch (IOException e) {
            inner = value;
            packing = null;
        }
        DecodedValue d = decodePlain(inner);
        if (packing == null && "raw".equals(d.format())) {
            byte[] snappy = SnappyDecoder.decodeRaw(value, MAX_UNPACKED);
            if (snappy != null && snappy.length > value.length) {
                DecodedValue unpacked = decodePlain(snappy);
                if (!"raw".equals(unpacked.format())) {
                    d = unpacked;
                    inner = snappy;
                    packing = "Snappy";
                }
            }
        }
        if (packing == null) {
            return d;
        }
        return new DecodedValue(d.format() + " + " + packingFormat(packing, value.length, inner.length), d.className(), d.text(), d.partial(),
                false, value.length, null);
    }

    private static String packingFormat(String packing, long sent, long unpacked) {
        return unpacked < 0 ? packing : packing + " · " + StoreCommandFacts.size(sent) + " sent, " + StoreCommandFacts.size(unpacked) + " unpacked";
    }

    private static DecodedValue decodePlain(byte[] v) {
        if (JdkStreamReader.looksLike(v)) {
            JdkStreamReader.Result r = JdkStreamReader.read(v);
            if (r != null) {
                return new DecodedValue(r.className() == null ? "JDK serialization" : "JDK serialization · " + r.className(), r.className(),
                        r.text(), r.partial(), false, v.length, null);
            }
        }
        String text = Resp.utf8(v);
        if (text != null) {
            String t = text.strip();
            if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
                try {
                    JsonNode node = JSON.readTree(t);
                    String cls = springClass(node);
                    return new DecodedValue(cls == null ? "JSON" : "Jackson JSON · " + cls, cls, JSON.writeValueAsString(node), false, false,
                            v.length, null);
                } catch (IOException notJson) {
                    // plain text below
                }
            }
            return new DecodedValue("text", null, text, false, false, v.length, null);
        }
        KryoReader.Result k = KryoReader.read(v);
        if (k != null) {
            return new DecodedValue(k.className() == null ? "Kryo (registered class - names not in the bytes)" : "Kryo · " + k.className(),
                    k.className(), k.text(), true, false, v.length, null);
        }
        return new DecodedValue("raw", null, hex(v), v.length > HEX_PREVIEW, false, v.length, null);
    }

    /** GenericJackson2JsonRedisSerializer: {"@class": "…"} or ["java.util.ArrayList", […]]. */
    private static String springClass(JsonNode node) {
        if (node.isObject() && node.has("@class") && node.get("@class").isTextual()) {
            return node.get("@class").asText();
        }
        if (node.isArray() && node.size() == 2 && node.get(0).isTextual() && node.get(0).asText().matches("[a-z][\\w.]*\\.[A-Z][\\w$]*")) {
            return node.get(0).asText();
        }
        return null;
    }

    static String hex(byte[] v) {
        StringBuilder out = new StringBuilder(Math.min(v.length, HEX_PREVIEW) * 3);
        for (int i = 0; i < v.length && i < HEX_PREVIEW; i++) {
            if (i > 0) {
                out.append(i % 32 == 0 ? '\n' : ' ');
            }
            out.append(String.format("%02x", v[i] & 0xff));
        }
        if (v.length > HEX_PREVIEW) {
            out.append(" … (").append(String.format("%,d", v.length)).append(" bytes - Raw bytes shows all)");
        }
        return out.toString();
    }

    static boolean gzip(byte[] v) {
        return v.length > 2 && (v[0] & 0xff) == 0x1f && (v[1] & 0xff) == 0x8b;
    }

    static boolean zlib(byte[] v) {
        return v.length > 2 && (v[0] & 0xff) == 0x78 && ((v[0] & 0xff) * 256 + (v[1] & 0xff)) % 31 == 0
                && ((v[1] & 0xff) == 0x01 || (v[1] & 0xff) == 0x5e || (v[1] & 0xff) == 0x9c || (v[1] & 0xff) == 0xda);
    }

    private static final class TooBig extends IOException {
        TooBig() {
            super("unpacked value over the display limit");
        }
    }

    private static byte[] unpack(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = s.read(buf)) > 0) {
                if (out.size() + n > MAX_UNPACKED) {
                    throw new TooBig();
                }
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }

    /**
     * A whole reply decoded: a bulk string's value decoded as above; an array/map/set as one line per element (a map's
     * as {@code field → value}), each element decoded; numbers and statuses as text.
     */
    public static DecodedValue decodeReply(byte[] reply) {
        if (reply == null || reply.length == 0) {
            return null;
        }
        Resp.Value v = Resp.parse(reply);
        if (v == null) {
            return decode(reply);
        }
        if (!v.isAggregate()) {
            if (v.nil()) {
                return new DecodedValue("nil", null, "(nil)", false, false, reply.length, null);
            }
            if (v.type() == '$' || v.type() == '=') {
                return decode(Resp.valueBytes(reply));
            }
            return new DecodedValue("reply", null, Resp.preview(reply, Integer.MAX_VALUE), false, false, reply.length, null);
        }
        StringBuilder out = new StringBuilder();
        boolean partial = false;
        boolean map = v.type() == '%';
        java.util.List<Resp.Value> els = v.elements();
        for (int i = 0; i < els.size(); i++) {
            if (map && i % 2 == 1) {
                continue;
            }
            if (out.length() > 0) {
                out.append('\n');
            }
            String one = element(els.get(i));
            if (map && i + 1 < els.size()) {
                out.append(one).append(" → ").append(element(els.get(i + 1)));
            } else {
                out.append(one);
            }
        }
        return new DecodedValue(map ? "map" : v.type() == '~' ? "set" : "array", null, out.toString(), partial, false, reply.length, null);
    }

    private static String element(Resp.Value e) {
        if (e.nil()) {
            return "(nil)";
        }
        if (e.isAggregate()) {
            StringBuilder s = new StringBuilder("[");
            for (int i = 0; i < e.elements().size(); i++) {
                s.append(i > 0 ? ", " : "").append(element(e.elements().get(i)));
            }
            return s.append(']').toString();
        }
        if (e.scalar() == null) {
            return "";
        }
        if (e.type() == '$' || e.type() == '=') {
            DecodedValue d = decode(e.scalar());
            return d.text() == null ? "" : d.text();
        }
        return new String(e.scalar(), java.nio.charset.StandardCharsets.UTF_8);
    }
}
