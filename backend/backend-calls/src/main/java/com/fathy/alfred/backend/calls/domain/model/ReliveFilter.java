package com.fathy.alfred.backend.calls.domain.model;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * The {@code relive} filter of a call list: blank lists every call, {@link #EXCLUDE} leaves out
 * every call that belongs to a Relive run (Live Calls - a run keeps its calls in its own cycle),
 * and anything else is a run id, listing only that run's calls - attributed to it
 * ({@code relive.runId}) or blocked as AMBIGUOUS for it ({@code relive.ambiguousRunIds}).
 */
public final class ReliveFilter {

    public static final String EXCLUDE = "exclude";

    private ReliveFilter() {
    }

    public static boolean isBlank(String filter) {
        return filter == null || filter.isBlank();
    }

    public static boolean matches(JsonNode relive, String filter) {
        if (isBlank(filter)) {
            return true;
        }
        boolean tagged = relive != null && !relive.isMissingNode() && !relive.isNull() && relive.size() > 0;
        if (EXCLUDE.equals(filter.trim())) {
            return !tagged;
        }
        return tagged && belongsTo(relive, filter.trim());
    }

    private static boolean belongsTo(JsonNode relive, String runId) {
        JsonNode attributed = relive.get("runId");
        if (attributed != null && attributed.isTextual() && runId.equals(attributed.asText())) {
            return true;
        }
        JsonNode ambiguous = relive.get("ambiguousRunIds");
        if (ambiguous != null && ambiguous.isArray()) {
            for (JsonNode id : ambiguous) {
                if (id.isTextual() && runId.equals(id.asText())) {
                    return true;
                }
            }
        }
        return false;
    }
}
