package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * The logged call a rule was made from - "⚡+ Rule" on a call card. Only a link the editor shows
 * ("Made from POST host/path") and follows back to the call; the proxy never sees it and it plays
 * no part in matching. The call may since have left the log, which the UI says rather than fails.
 *
 * @param direction "outbound" or "inbound" - which log the id belongs to
 * @param callId    the call's id in that log (or in the cycle)
 * @param cycleId   the session cycle holding the copy the rule was made from, or null for Live Calls
 * @param label       "POST httpbin.org/anything", as it read when the rule was made - shown even
 *                    when the call itself is gone
 * @param serviceName the project an inbound call belongs to, so going back to it can show that
 *                    project's calls; null for outbound
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SourceCallRef(String direction, String callId, String cycleId, String label, String serviceName) {

    /** What is wrong with it, for RuleValidator - empty when it is fine. */
    public java.util.List<String> problems() {
        java.util.List<String> problems = new java.util.ArrayList<>();
        if (!"outbound".equals(direction) && !"inbound".equals(direction)) {
            problems.add("A source call's direction is outbound or inbound.");
        }
        if (callId == null || callId.isBlank() || callId.length() > 64) {
            problems.add("A source call needs an id of at most 64 characters.");
        }
        if (cycleId != null && cycleId.length() > 64) {
            problems.add("A source call's cycle id is at most 64 characters.");
        }
        if (serviceName != null && serviceName.length() > 120) {
            problems.add("A source call's project name is at most 120 characters.");
        }
        if (label != null && label.length() > 300) {
            problems.add("A source call's label is at most 300 characters.");
        }
        return problems;
    }
}
