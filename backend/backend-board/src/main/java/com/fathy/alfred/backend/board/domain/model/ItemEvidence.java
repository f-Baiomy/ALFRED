package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.util.List;

/**
 * What shows that one Acceptance item holds (specs/018): the endpoint whose calls show it ({@code METHOD /pattern}, the
 * way triage names an endpoint, or {@code UI} for an item no call can show), the checks each such call must pass, and
 * what to do in the app to make that call. Drafted by Claude from the spec, edited by the user; the user's edit wins.
 */
public record ItemEvidence(String cycleId, String fileName, String itemKey, String project, String endpoint,
                           List<EvidenceCheck> checks, String howTo, Actor updatedBy, Instant updatedAt) {

    public static final String UI = "UI";
    public static final int MAX_CHECKS = 10;
    public static final int MAX_HOW_TO = 300;
    public static final int MAX_ENDPOINT = 300;

    public ItemEvidence {
        project = project == null ? "" : project.strip();
        endpoint = endpoint == null ? null : endpoint.strip().replaceAll("\\s+", " ");
        checks = checks == null ? List.of() : List.copyOf(checks);
        howTo = howTo == null ? "" : howTo.strip();
    }

    /** An item only a person can check (a dropdown's options, a label). */
    public boolean manual() {
        return UI.equalsIgnoreCase(endpoint);
    }

    /** Why this evidence cannot be used, or null when it is fine. */
    public String problem() {
        if (endpoint == null || endpoint.isEmpty() || endpoint.length() > MAX_ENDPOINT) {
            return "endpoint is required: METHOD /path (as triage names it, e.g. POST /odeysysadmin/{x}/refunded-requests/search) or UI";
        }
        if (!manual()) {
            if (!endpoint.matches("(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /\\S*")) {
                return "endpoint must be METHOD /path, e.g. POST /api/orders/{n} - or UI";
            }
            if (checks.isEmpty()) {
                return "an endpoint needs at least one check";
            }
        }
        if (checks.size() > MAX_CHECKS) {
            return "at most " + MAX_CHECKS + " checks per item";
        }
        for (EvidenceCheck c : checks) {
            String p = c == null ? "a check is empty" : c.problem();
            if (p != null) {
                return p;
            }
        }
        return howTo.length() > MAX_HOW_TO ? "howTo is at most " + MAX_HOW_TO + " characters" : null;
    }
}
