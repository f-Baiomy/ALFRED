package com.fathy.alfred.backend.links.domain;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.StreamReadConstraints;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.Deque;

/**
 * Copies a JSON document token by token, letting a {@link Visitor} change string values - so a 200 MB answer is rewritten
 * without ever being held whole (R3). Used to mask secrets at the source (D17, D28) and to give ids read through a link
 * their {@code @slug} (R1). Numbers, booleans and structure are copied exactly; a subtree the visitor declines is copied
 * untouched.
 */
public final class JsonRewriter {

    /** No length limits: a call body is one JSON string and can be hundreds of megabytes - an export never cuts it (D23). */
    private static final JsonFactory FACTORY = JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder().maxStringLength(Integer.MAX_VALUE).maxNumberLength(100_000)
                    .maxNestingDepth(10_000).build())
            .build();

    /** Decides what changes. {@code path} holds the field names from the root ("[]" for an array element), innermost last. */
    public interface Visitor {

        /** The value to write instead of {@code value} (return it unchanged to keep it). */
        String string(Deque<String> path, String value);

        /** False copies the whole value under {@code field} without visiting it. */
        default boolean descend(Deque<String> path, String field) {
            return true;
        }

        /** A replacement written as a string instead of a number, boolean or null at {@code path}; null keeps the value. */
        default String scalar(Deque<String> path) {
            return null;
        }
    }

    private JsonRewriter() {
    }

    public static void rewrite(InputStream in, OutputStream out, Visitor visitor) throws IOException {
        try (JsonParser p = FACTORY.createParser(in);
             JsonGenerator g = FACTORY.createGenerator(out)) {
            g.disable(JsonGenerator.Feature.AUTO_CLOSE_TARGET);
            Deque<String> path = new ArrayDeque<>();
            JsonToken t;
            while ((t = p.nextToken()) != null) {
                value(p, g, t, path, visitor);
            }
            g.flush();
        }
    }

    public static String rewrite(String json, Visitor visitor) {
        try {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            rewrite(new java.io.ByteArrayInputStream(json.getBytes(java.nio.charset.StandardCharsets.UTF_8)), out, visitor);
            return out.toString(java.nio.charset.StandardCharsets.UTF_8);
        } catch (IOException e) {
            return json;
        }
    }

    private static void value(JsonParser p, JsonGenerator g, JsonToken t, Deque<String> path, Visitor v) throws IOException {
        switch (t) {
            case START_OBJECT -> {
                g.writeStartObject();
                JsonToken n;
                while ((n = p.nextToken()) != JsonToken.END_OBJECT) {
                    if (n != JsonToken.FIELD_NAME) {
                        throw new IOException("Expected a field name");
                    }
                    String field = p.currentName();
                    g.writeFieldName(field);
                    JsonToken vt = p.nextToken();
                    if (!v.descend(path, field)) {
                        g.copyCurrentStructure(p);
                        continue;
                    }
                    path.addLast(field);
                    value(p, g, vt, path, v);
                    path.removeLast();
                }
                g.writeEndObject();
            }
            case START_ARRAY -> {
                g.writeStartArray();
                JsonToken n;
                while ((n = p.nextToken()) != JsonToken.END_ARRAY) {
                    path.addLast("[]");
                    value(p, g, n, path, v);
                    path.removeLast();
                }
                g.writeEndArray();
            }
            case VALUE_STRING -> g.writeString(v.string(path, p.getText()));
            case VALUE_NUMBER_INT, VALUE_NUMBER_FLOAT, VALUE_TRUE, VALUE_FALSE, VALUE_NULL -> {
                String replaced = v.scalar(path);
                if (replaced == null) {
                    g.copyCurrentEvent(p);
                } else {
                    g.writeString(replaced);
                }
            }
            default -> g.copyCurrentEvent(p);
        }
    }
}
