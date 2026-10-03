package com.fathy.alfred.backend.logs.domain.ingest;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Turns one parsed log line into {@code path -> scalar} (FR-010): nested objects become dotted
 * paths, one-element arrays are unwrapped (OpenSearch's {@code fields.VM_name: ["portal-24"]}),
 * longer arrays stay as JSON text, a text value that is itself a JSON object is unpacked under its
 * own path, and {@code Name(k=v, ...)} text gets its keys as child fields while keeping the text.
 *
 * <p>Values are {@code String}, {@code Number}, {@code Boolean} or {@code null}.
 */
public final class Flattener {

    /** Unpacking recursion guard: JSON-in-text inside JSON-in-text, a few levels deep at most. */
    private static final int MAX_UNPACK_DEPTH = 3;

    private final ObjectMapper mapper;

    public Flattener(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    public Result flatten(JsonNode root) {
        return flatten(root, Set.of());
    }

    /**
     * @param payloads paths kept as ONE text value (their JSON) instead of being walked - see {@link PayloadRule}
     */
    public Result flatten(JsonNode root, Set<String> payloads) {
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Boolean> unpacked = new LinkedHashMap<>();
        walk(root, "", out, unpacked, 0, payloads);
        return new Result(out, unpacked.keySet());
    }

    /**
     * @param unpackedRoots paths whose text value was JSON and got unpacked - candidates for
     *                      duplicate detection ({@link StructureDetector})
     */
    public record Result(Map<String, Object> values, Set<String> unpackedRoots) {
    }

    private void walk(JsonNode node, String path, Map<String, Object> out, Map<String, Boolean> unpacked, int depth,
                      Set<String> payloads) {
        if (node == null || node.isMissingNode()) {
            return;
        }
        if (!payloads.isEmpty() && payloads.contains(path)) {
            out.put(path, node.isNull() ? null : node.isTextual() ? node.asText() : node.toString());
            return;
        }
        if (node.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> it = node.fields();
            if (!it.hasNext() && !path.isEmpty()) {
                return; // {} carries nothing to show or search
            }
            while (it.hasNext()) {
                var e = it.next();
                walk(e.getValue(), path.isEmpty() ? e.getKey() : path + "." + e.getKey(), out, unpacked, depth, payloads);
            }
        } else if (node.isArray()) {
            if (node.size() == 1) {
                walk(node.get(0), path, out, unpacked, depth, payloads);
            } else if (node.size() > 1) {
                out.put(path, node.toString());
            }
        } else if (node.isNull()) {
            out.put(path, null);
        } else if (node.isBoolean()) {
            out.put(path, node.booleanValue());
        } else if (node.isNumber()) {
            out.put(path, node.numberValue());
        } else {
            String text = node.asText();
            if (depth < MAX_UNPACK_DEPTH && looksLikeJsonObject(text)) {
                try {
                    JsonNode inner = mapper.readTree(text);
                    if (inner != null && inner.isObject() && inner.size() > 0) {
                        unpacked.put(path, true);
                        walk(inner, path, out, unpacked, depth + 1, payloads);
                        return;
                    }
                } catch (Exception ignored) {
                    // Not JSON after all: an invalid JSON-looking text is kept as text (spec edge case).
                }
            }
            out.put(path, text);
            ObjectTextParser.parse(text).ifPresent(kv -> kv.forEach((k, v) ->
                    out.put(path + "." + k, "null".equals(v) ? null : v)));
        }
    }

    private static boolean looksLikeJsonObject(String text) {
        String t = text.strip();
        return t.length() >= 2 && t.charAt(0) == '{' && t.charAt(t.length() - 1) == '}';
    }
}
