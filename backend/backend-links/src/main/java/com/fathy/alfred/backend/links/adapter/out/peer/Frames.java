package com.fathy.alfred.backend.links.adapter.out.peer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

/**
 * The link protocol (R3, R4), version {@link #PROTO}. Control frames are JSON text: {@code challenge}, {@code auth},
 * {@code welcome}, {@code ping}/{@code pong}, {@code req}, {@code head}, {@code end}, {@code err}, {@code credit},
 * {@code cancel}, {@code event}/{@code ack}, {@code signal}, {@code bye}. A body chunk is one binary frame: a 4-byte
 * header length, the JSON header {@code {"t":"chunk","id":…}}, then the bytes. A frame of a kind a side does not know
 * is dropped, so a newer Alfred can add kinds.
 */
final class Frames {

    static final int PROTO = 1;
    /** One body chunk: small enough that a slow reader holds little, large enough that a big body needs few round trips. */
    static final int CHUNK = 128 * 1024;

    static final ObjectMapper JSON = new ObjectMapper();

    record Chunk(String id, ByteBuffer data) {
    }

    private Frames() {
    }

    static ObjectNode frame(String type) {
        ObjectNode n = JSON.createObjectNode();
        n.put("t", type);
        return n;
    }

    static JsonNode parse(String text) {
        try {
            return JSON.readTree(text);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static String text(JsonNode node) {
        try {
            return JSON.writeValueAsString(node);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static ByteBuffer chunk(String id, byte[] data, int offset, int length) {
        ObjectNode h = frame("chunk");
        h.put("id", id);
        byte[] head = text(h).getBytes(StandardCharsets.UTF_8);
        ByteBuffer b = ByteBuffer.allocate(4 + head.length + length);
        b.putInt(head.length);
        b.put(head);
        b.put(data, offset, length);
        b.flip();
        return b;
    }

    static Chunk readChunk(ByteBuffer b) {
        int n = b.getInt();
        if (n <= 0 || n > b.remaining()) {
            throw new IllegalArgumentException("Bad chunk header");
        }
        byte[] h = new byte[n];
        b.get(h);
        JsonNode head = parse(new String(h, StandardCharsets.UTF_8));
        ByteBuffer data = ByteBuffer.allocate(b.remaining());
        data.put(b);
        data.flip();
        return new Chunk(head.path("id").asText(), data);
    }
}
