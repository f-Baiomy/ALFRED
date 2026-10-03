package com.fathy.alfred.backend.sessioncycles.domain.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;

/** The Relive runs a logged call belongs to, read from its {@code relive} tag: the run it was
 *  attributed to ({@code runId}), or every run it was blocked as AMBIGUOUS for
 *  ({@code ambiguousRunIds}). Empty for a call no run claimed. */
public final class ReliveRunIds {

    private ReliveRunIds() {
    }

    public static List<String> of(JsonNode relive) {
        if (relive == null || relive.isMissingNode() || relive.isNull()) {
            return List.of();
        }
        JsonNode runId = relive.get("runId");
        if (runId != null && runId.isTextual() && !runId.asText().isBlank()) {
            return List.of(runId.asText());
        }
        List<String> ids = new ArrayList<>();
        JsonNode ambiguous = relive.get("ambiguousRunIds");
        if (ambiguous != null && ambiguous.isArray()) {
            for (JsonNode id : ambiguous) {
                if (id.isTextual() && !id.asText().isBlank()) {
                    ids.add(id.asText());
                }
            }
        }
        return ids;
    }
}
