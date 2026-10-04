package com.fathy.alfred.dbagent.transport;

import java.util.List;
import java.util.Map;

/**
 * The agent writes its own JSON: it runs inside someone else's application, so it must not bring (or collide with)
 * a JSON library. Only what the batch format needs.
 */
public final class JsonWriter {

    private final StringBuilder out = new StringBuilder(4096);
    private boolean needComma;

    public JsonWriter beginObject() {
        comma();
        out.append('{');
        needComma = false;
        return this;
    }

    public JsonWriter endObject() {
        out.append('}');
        needComma = true;
        return this;
    }

    public JsonWriter beginArray() {
        comma();
        out.append('[');
        needComma = false;
        return this;
    }

    public JsonWriter endArray() {
        out.append(']');
        needComma = true;
        return this;
    }

    public JsonWriter name(String name) {
        comma();
        string(name);
        out.append(':');
        needComma = false;
        return this;
    }

    public JsonWriter value(String value) {
        comma();
        if (value == null) {
            out.append("null");
        } else {
            string(value);
        }
        needComma = true;
        return this;
    }

    public JsonWriter value(long value) {
        comma();
        out.append(value);
        needComma = true;
        return this;
    }

    public JsonWriter value(boolean value) {
        comma();
        out.append(value);
        needComma = true;
        return this;
    }

    public JsonWriter nullValue() {
        comma();
        out.append("null");
        needComma = true;
        return this;
    }

    /** Writes the field only when the value is non-null - keeps batches small. */
    public JsonWriter field(String name, String value) {
        return value == null ? this : name(name).value(value);
    }

    public JsonWriter field(String name, Number value) {
        if (value == null) {
            return this;
        }
        name(name);
        comma();
        out.append(value);
        needComma = true;
        return this;
    }

    public JsonWriter field(String name, Boolean value) {
        return value == null ? this : name(name).value(value.booleanValue());
    }

    public JsonWriter stringArray(String name, List<String> values) {
        if (values == null) {
            return this;
        }
        name(name).beginArray();
        for (String v : values) {
            value(v);
        }
        return endArray();
    }

    public JsonWriter longMap(String name, Map<String, Long> values) {
        name(name).beginObject();
        for (Map.Entry<String, Long> e : values.entrySet()) {
            name(e.getKey()).value(e.getValue());
        }
        return endObject();
    }

    private void comma() {
        if (needComma) {
            out.append(',');
            needComma = false;
        }
    }

    private void string(String s) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                default:
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append('"');
    }

    public int length() {
        return out.length();
    }

    @Override
    public String toString() {
        return out.toString();
    }
}
