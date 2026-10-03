package com.fathy.alfred.backend.logs.domain.ingest;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;

import java.util.Iterator;
import java.util.Map;
import java.util.Set;

/**
 * Privacy "redact at load" (FR-043): replaces the values of fields marked sensitive in the parsed
 * line before anything is stored, so neither the stored fields nor the stored raw line keep the
 * original. Paths follow {@link Flattener}'s rules; a sensitive field that lives inside JSON-in-text
 * or {@code Name(k=v)} text redacts that whole text value, because its parts cannot be edited
 * without re-serialising it.
 */
public final class Redactor {

    public static final String MASK = "[redacted]";

    private Redactor() {
    }

    /** @return true when anything was redacted (the raw line must then be re-serialised) */
    public static boolean redact(JsonNode root, Set<String> sensitivePaths) {
        return !sensitivePaths.isEmpty() && walk(root, "", sensitivePaths);
    }

    public static void redactValues(Map<String, Object> values, Set<String> sensitivePaths) {
        for (String p : sensitivePaths) {
            values.computeIfPresent(p, (k, v) -> MASK);
        }
        values.replaceAll((k, v) -> sensitivePaths.stream().anyMatch(s -> k.startsWith(s + ".")) ? MASK : v);
    }

    private static boolean walk(JsonNode node, String path, Set<String> sensitive) {
        boolean changed = false;
        if (node instanceof ObjectNode obj) {
            Iterator<Map.Entry<String, JsonNode>> it = obj.fields();
            while (it.hasNext()) {
                var e = it.next();
                String p = path.isEmpty() ? e.getKey() : path + "." + e.getKey();
                if (hits(p, sensitive, e.getValue())) {
                    e.setValue(TextNode.valueOf(MASK));
                    changed = true;
                } else {
                    changed |= walk(e.getValue(), p, sensitive);
                }
            }
        } else if (node instanceof ArrayNode arr && arr.size() == 1) {
            if (hits(path, sensitive, arr.get(0))) {
                arr.set(0, TextNode.valueOf(MASK));
                changed = true;
            } else {
                changed |= walk(arr.get(0), path, sensitive);
            }
        }
        return changed;
    }

    /** The path itself is sensitive, or this is a text value that holds a sensitive child. */
    private static boolean hits(String path, Set<String> sensitive, JsonNode value) {
        if (sensitive.contains(path)) {
            return true;
        }
        return value.isTextual() && sensitive.stream().anyMatch(s -> s.startsWith(path + "."));
    }
}
