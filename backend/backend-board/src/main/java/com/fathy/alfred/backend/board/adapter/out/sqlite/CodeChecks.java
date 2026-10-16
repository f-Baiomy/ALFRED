package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CodeCheck;

import java.util.ArrayList;
import java.util.List;

/** A code check's layers as JSON in board.db, read leniently: a layer it cannot read is left out, never an error. */
final class CodeChecks {

    private static final ObjectMapper JSON = new ObjectMapper();

    private CodeChecks() {
    }

    static String layersJson(List<CodeCheck.Layer> layers) {
        ArrayNode out = JSON.createArrayNode();
        for (CodeCheck.Layer l : layers) {
            var n = out.addObject();
            n.put("team", l.team());
            n.put("where", l.where());
            n.put("ok", l.ok());
            if (l.note() != null) {
                n.put("note", l.note());
            }
        }
        return out.toString();
    }

    static List<CodeCheck.Layer> layers(String json) {
        List<CodeCheck.Layer> out = new ArrayList<>();
        if (json == null || json.isBlank()) {
            return out;
        }
        try {
            for (JsonNode n : JSON.readTree(json)) {
                out.add(new CodeCheck.Layer(text(n, "team"), text(n, "where"), n.path("ok").asBoolean(false), text(n, "note")));
            }
        } catch (Exception e) {
            // unreadable: no layers
        }
        return out;
    }

    static Actor actor(String name) {
        try {
            return Actor.valueOf(name);
        } catch (RuntimeException e) {
            return Actor.CLAUDE;
        }
    }

    private static String text(JsonNode n, String field) {
        return n.hasNonNull(field) ? n.get(field).asText() : null;
    }
}
