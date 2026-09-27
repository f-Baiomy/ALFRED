package com.fathy.alfred.backend.settings.application.port.in;
import java.util.Map;

/** Contracts.md section 1 (B3 variables by source, C2 environments, D6 secret variables). */
public interface ManageGlobalVariablesUseCase {
    /** The active environment's view plus metadata - see contracts.md section 1's state shape. */
    Map<String, Object> get();

    /** Full-state replace (bulk {@code PUT /settings/variables}) of the ACTIVE environment. */
    Map<String, Object> save(Map<String, Object> state);

    /**
     * Merges one promoted value (a proxy GLOBAL capture) into the active environment - source
     * becomes CAPTURE. {@code ruleId}/{@code ruleName} (both nullable) name the rule that captured
     * it, carried straight into the source entry.
     */
    Map<String, Object> promote(String name, Object value, String ruleId, String ruleName);

    /** Upsert of a single variable in the active environment (UI edit) - source becomes MANUAL. */
    Map<String, Object> upsert(String name, String value);

    /**
     * Removes a single variable from the active environment (UI delete). {@code fallbackOrNull}
     * replaces its fallback when non-null, or clears it when null - the tombstone (its
     * {@code updatedAt} entry) stays either way, and its source entry is dropped.
     */
    Map<String, Object> remove(String name, String fallbackOrNull);

    /** Marks (or unmarks) a name as secret - a GLOBAL list, shared by every environment. */
    Map<String, Object> setSecret(String name, boolean secret);

    /** Creates a new, empty (or copied) environment. Never activates it. */
    Map<String, Object> createEnvironment(String name, String copyFromOrNull);

    /** Switches the active environment and republishes {@code variables.json}. */
    Map<String, Object> activateEnvironment(String name);

    /** 400 if {@code name} is the active environment, or the last one left. */
    Map<String, Object> deleteEnvironment(String name);

    /** {@code {name, variables, fallbacks}} for one environment. */
    Map<String, Object> exportEnvironment(String name);

    /**
     * Imports variables into {@code environment} (created if absent). {@code mode} is
     * {@code MERGE} (upsert onto what's there) or {@code REPLACE} (wholesale). Imported names get
     * source IMPORT. {@code variables} is required; {@code fallbacks} is optional (may be null).
     */
    Map<String, Object> importEnvironment(String environment, Object variables, Object fallbacks, String mode);
}
