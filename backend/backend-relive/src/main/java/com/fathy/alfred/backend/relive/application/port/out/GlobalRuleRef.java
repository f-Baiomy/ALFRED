package com.fathy.alfred.backend.relive.application.port.out;

/** A global interception rule as seen from Relive: enough to list and pick it, not its body. */
public record GlobalRuleRef(String id, String name, boolean enabled, com.fasterxml.jackson.databind.JsonNode match) {

    public GlobalRuleRef(String id, String name, boolean enabled) {
        this(id, name, enabled, null);
    }
}
