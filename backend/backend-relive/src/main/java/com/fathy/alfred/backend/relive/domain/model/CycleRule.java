package com.fathy.alfred.backend.relive.domain.model;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * An interception rule document (match, actions, priority, stopProcessing, enabled, name) in
 * ALFRED's existing wire shape, plus where it was copied from if it started as a global rule.
 * This slice never interprets {@code rule} - the frontend renders it with the existing rule
 * editor, the proxy evaluates it with the existing engine (data-model.md "CycleRule"). Used for
 * cycle rules, each step's one call rule, and unexpected-call rules - the same shape everywhere.
 */
public record CycleRule(JsonNode rule, CopiedFrom copiedFrom) {
}
