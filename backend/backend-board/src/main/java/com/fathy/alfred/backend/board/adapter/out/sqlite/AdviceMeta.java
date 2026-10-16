package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.domain.model.Advice;

import java.util.ArrayList;
import java.util.List;

/** Reads the {@code advice_meta} JSON of a question row leniently: a field it cannot read is left out, never an error. */
final class AdviceMeta {

    private static final ObjectMapper JSON = new ObjectMapper();

    private AdviceMeta() {
    }

    static Advice read(String option, String meta) {
        if (meta == null || meta.isBlank()) {
            return Advice.of(option);
        }
        try {
            JsonNode m = JSON.readTree(meta);
            List<Integer> group = new ArrayList<>();
            m.path("group").forEach(n -> {
                if (n.canConvertToInt() && n.asInt() > 0) {
                    group.add(n.asInt());
                }
            });
            JsonNode sev = m.path("severity");
            return new Advice(option, text(m, "confidence"), text(m, "checked"), sev.path("rank").isInt() ? sev.path("rank").asInt() : null,
                    sev.path("of").isInt() ? sev.path("of").asInt() : null, text(sev, "note"), group);
        } catch (Exception e) {
            return Advice.of(option);
        }
    }

    private static String text(JsonNode node, String field) {
        String s = node.hasNonNull(field) ? node.get(field).asText().strip() : "";
        return s.isEmpty() ? null : s;
    }
}
