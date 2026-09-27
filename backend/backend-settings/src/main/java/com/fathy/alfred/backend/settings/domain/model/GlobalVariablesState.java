package com.fathy.alfred.backend.settings.domain.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Storage-shape helpers for the multi-environment global-variable state (contracts.md section 1 -
 * B3 variables by source, C2 environments, D6 secret variables). Shared by both the SQLite and
 * JSON-file adapters so the environment model, the legacy-flat migration, and the proxy-file
 * absorb algorithm exist in exactly one place.
 *
 * <p>The BACKEND's own state (a SQLite row's JSON blob, or the equivalent keys in the file-mode
 * store) is always this nested shape:
 * <pre>{ activeEnvironment, environments: { name: { variables, fallbacks, updatedAt, sources } }, secrets }</pre>
 * A legacy flat state (from before environments existed - just {@code variables}/{@code
 * fallbacks}/{@code updatedAt} at the top level, or nothing at all) migrates on first read to one
 * environment named {@value #DEFAULT_ENVIRONMENT}.
 *
 * <p>The PUBLISHED file the proxies read ({@code variables.json}) is always the flat,
 * active-environment view: {@code {environment, variables, fallbacks, updatedAt, secrets}} plus
 * {@code promotedAt}/{@code promotedBy}, written by the proxy on a GLOBAL capture and read back
 * by {@link #absorb}.
 */
public final class GlobalVariablesState {

    public static final String DEFAULT_ENVIRONMENT = "Default";

    /** Mirrors GlobalVariablesService's own copy - kept here too since {@link #absorb} needs it and cannot reach the service. */
    public static final Pattern NAME = Pattern.compile("[A-Za-z][A-Za-z0-9_.-]*");

    private GlobalVariablesState() {
    }

    // ---- migration ----

    /** Idempotent: a state that already has an {@code environments} map is returned unchanged. */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> migrate(Map<String, Object> raw) {
        if (raw != null && raw.get("environments") instanceof Map) {
            return raw;
        }
        Map<String, Object> legacy = raw == null ? Map.of() : raw;
        Map<String, Object> defaultEnv = newEnvironment(
                stringMapOrEmpty(legacy.get("variables")),
                stringMapOrEmpty(legacy.get("fallbacks")),
                longMapOrEmpty(legacy.get("updatedAt")),
                Map.of());
        Map<String, Object> environments = new LinkedHashMap<>();
        environments.put(DEFAULT_ENVIRONMENT, defaultEnv);

        Map<String, Object> migrated = new LinkedHashMap<>();
        migrated.put("activeEnvironment", DEFAULT_ENVIRONMENT);
        migrated.put("environments", environments);
        migrated.put("secrets", List.of());
        return migrated;
    }

    public static Map<String, Object> newEnvironment(Map<String, String> variables, Map<String, String> fallbacks,
            Map<String, Long> updatedAt, Map<String, Object> sources) {
        Map<String, Object> env = new LinkedHashMap<>();
        env.put("variables", Map.copyOf(variables));
        env.put("fallbacks", Map.copyOf(fallbacks));
        env.put("updatedAt", Map.copyOf(updatedAt));
        env.put("sources", Map.copyOf(sources));
        return env;
    }

    /** A CAPTURE/MANUAL/IMPORT source entry - {@code ruleId}/{@code ruleName} only ever set for CAPTURE. */
    public static Map<String, Object> source(String kind, String ruleId, String ruleName) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("kind", kind);
        if ("CAPTURE".equals(kind)) {
            if (ruleId != null) entry.put("ruleId", ruleId);
            if (ruleName != null) entry.put("ruleName", ruleName);
        }
        return entry;
    }

    // ---- accessors ----

    @SuppressWarnings("unchecked")
    public static Map<String, Object> environments(Map<String, Object> state) {
        if (state.get("environments") instanceof Map<?, ?> m && !m.isEmpty()) {
            return (Map<String, Object>) m;
        }
        // An empty store (or a legacy flat state) still has the required Default environment.
        // Keeping this invariant here also covers stores that do not migrate on load.
        return Map.of(DEFAULT_ENVIRONMENT, newEnvironment(
                stringMapOrEmpty(state.get("variables")),
                stringMapOrEmpty(state.get("fallbacks")),
                longMapOrEmpty(state.get("updatedAt")),
                Map.of()));
    }

    public static String activeEnvironment(Map<String, Object> state) {
        Object value = state.get("activeEnvironment");
        return value instanceof String s && !s.isBlank() ? s : DEFAULT_ENVIRONMENT;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> environment(Map<String, Object> state, String name) {
        Object value = environments(state).get(name);
        return value instanceof Map<?, ?> m ? (Map<String, Object>) m : newEnvironment(Map.of(), Map.of(), Map.of(), Map.of());
    }

    public static Map<String, String> variablesOf(Map<String, Object> env) {
        return stringMapOrEmpty(env.get("variables"));
    }

    public static Map<String, String> fallbacksOf(Map<String, Object> env) {
        return stringMapOrEmpty(env.get("fallbacks"));
    }

    public static Map<String, Long> updatedAtOf(Map<String, Object> env) {
        return longMapOrEmpty(env.get("updatedAt"));
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> sourcesOf(Map<String, Object> env) {
        return env.get("sources") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
    }

    public static List<String> secrets(Map<String, Object> state) {
        List<String> out = new ArrayList<>();
        if (state.get("secrets") instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof String s) out.add(s);
            }
        }
        return out;
    }

    // ---- state edits (all return a NEW top-level map; callers still own copy-on-write of nested maps) ----

    public static Map<String, Object> withEnvironment(Map<String, Object> state, String name, Map<String, Object> env) {
        Map<String, Object> environments = new LinkedHashMap<>(environments(state));
        environments.put(name, env);
        Map<String, Object> next = new LinkedHashMap<>(state);
        next.put("environments", environments);
        return next;
    }

    public static Map<String, Object> withoutEnvironment(Map<String, Object> state, String name) {
        Map<String, Object> environments = new LinkedHashMap<>(environments(state));
        environments.remove(name);
        Map<String, Object> next = new LinkedHashMap<>(state);
        next.put("environments", environments);
        return next;
    }

    public static Map<String, Object> withActiveEnvironment(Map<String, Object> state, String name) {
        Map<String, Object> next = new LinkedHashMap<>(state);
        next.put("activeEnvironment", name);
        return next;
    }

    public static Map<String, Object> withSecrets(Map<String, Object> state, List<String> secrets) {
        Map<String, Object> next = new LinkedHashMap<>(state);
        next.put("secrets", List.copyOf(secrets));
        return next;
    }

    // ---- view builders ----

    /** {@code GET /settings/variables} and every mutation's response - contracts.md section 1. */
    public static Map<String, Object> view(Map<String, Object> state) {
        String active = activeEnvironment(state);
        Map<String, Object> env = environment(state, active);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("variables", env.get("variables"));
        out.put("fallbacks", env.get("fallbacks"));
        out.put("updatedAt", env.get("updatedAt"));
        out.put("sources", env.get("sources"));
        out.put("secrets", secrets(state));
        out.put("activeEnvironment", active);
        List<String> names = new ArrayList<>(environments(state).keySet());
        Collections.sort(names);
        out.put("environments", names);
        return out;
    }

    /** {@code variables.json} - the flat, active-environment view the proxies read. */
    public static Map<String, Object> publishedView(Map<String, Object> state) {
        String active = activeEnvironment(state);
        Map<String, Object> env = environment(state, active);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("environment", active);
        out.put("variables", env.get("variables"));
        out.put("fallbacks", env.get("fallbacks"));
        out.put("updatedAt", env.get("updatedAt"));
        out.put("secrets", secrets(state));
        return out;
    }

    // ---- absorb (file -> backend state) ----

    /**
     * Folds a proxy-written GLOBAL capture from the published file into {@code state} (already
     * {@link #migrate migrated}). A file value is absorbed into the environment named by the
     * file's {@code environment} (else the active one) only when its {@code promotedAt} is newer
     * than that environment's own {@code updatedAt} for the name - its source becomes CAPTURE with
     * {@code promotedBy}. Returns {@code null} when nothing changed (mirrors the store's
     * {@code update()} no-op contract).
     *
     * <p>Best-effort by design: a target environment the file names but this deployment no longer
     * has (deleted since, or a stale/hand-edited file) is skipped entirely rather than silently
     * recreated - absorption must never grow the environment count past what the UI created.
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> absorb(Map<String, Object> state, Map<String, Object> fileState) {
        if (fileState == null) return null;
        Map<String, Long> filePromotedAt = longMapOrEmpty(fileState.get("promotedAt"));
        if (filePromotedAt.isEmpty()) return null;

        Object envNameRaw = fileState.get("environment");
        String targetEnvName = envNameRaw instanceof String s && !s.isBlank() ? s : activeEnvironment(state);
        if (!environments(state).containsKey(targetEnvName)) return null;

        Map<String, String> fileVariables = stringMapOrEmpty(fileState.get("variables"));
        Map<String, Object> filePromotedBy = fileState.get("promotedBy") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();

        Map<String, Object> targetEnv = environment(state, targetEnvName);
        Map<String, String> variables = new LinkedHashMap<>(variablesOf(targetEnv));
        Map<String, String> fallbacks = new LinkedHashMap<>(fallbacksOf(targetEnv));
        Map<String, Long> updatedAt = new LinkedHashMap<>(updatedAtOf(targetEnv));
        Map<String, Object> sources = new LinkedHashMap<>(sourcesOf(targetEnv));

        boolean changed = false;
        for (var entry : filePromotedAt.entrySet()) {
            String name = entry.getKey();
            if (!NAME.matcher(name).matches() || name.startsWith("this.")) continue;
            String value = fileVariables.get(name);
            if (value == null) continue;
            long promotedAt = entry.getValue();
            long known = updatedAt.getOrDefault(name, 0L);
            if (promotedAt <= known) continue;
            if (value.equals(variables.get(name))) continue;

            variables.put(name, value);
            fallbacks.remove(name);
            updatedAt.put(name, promotedAt);
            String ruleId = null;
            String ruleName = null;
            if (filePromotedBy.get(name) instanceof Map<?, ?> by) {
                if (by.get("ruleId") instanceof String rid) ruleId = rid;
                if (by.get("ruleName") instanceof String rn) ruleName = rn;
            }
            sources.put(name, source("CAPTURE", ruleId, ruleName));
            changed = true;
        }
        if (!changed) return null;

        return withEnvironment(state, targetEnvName, newEnvironment(variables, fallbacks, updatedAt, sources));
    }

    // ---- primitive coercion ----

    public static Map<String, String> stringMapOrEmpty(Object value) {
        if (value instanceof Map<?, ?> raw) {
            Map<String, String> out = new LinkedHashMap<>();
            for (var entry : raw.entrySet()) {
                if (entry.getKey() instanceof String key && entry.getValue() instanceof String text) out.put(key, text);
            }
            return out;
        }
        return Map.of();
    }

    /** Coerces Jackson's Integer/Long/etc. to long; drops anything that isn't a number. */
    public static Map<String, Long> longMapOrEmpty(Object value) {
        if (value instanceof Map<?, ?> raw) {
            Map<String, Long> out = new LinkedHashMap<>();
            for (var entry : raw.entrySet()) {
                if (entry.getKey() instanceof String key && entry.getValue() instanceof Number number) out.put(key, number.longValue());
            }
            return out;
        }
        return Map.of();
    }
}
