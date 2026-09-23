package com.fathy.alfred.backend.internalcalls.domain.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/** Normalises resend_edits text from outside: compact JSON object text, or null. */
public final class ResendEdits {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private ResendEdits() {
    }

    public static String normalise(Object raw) {
        if (raw == null) {
            return null;
        }
        try {
            JsonNode node = raw instanceof String s ? MAPPER.readTree(s) : MAPPER.valueToTree(raw);
            return node != null && node.isObject() ? MAPPER.writeValueAsString(node) : null;
        } catch (JsonProcessingException | IllegalArgumentException e) {
            return null;
        }
    }
}
