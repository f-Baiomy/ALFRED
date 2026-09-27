package com.fathy.alfred.backend.settings.application.service;

import com.fathy.alfred.backend.settings.application.port.in.ManageGlobalVariablesUseCase;
import com.fathy.alfred.backend.settings.application.port.out.GlobalVariablesStorePort;
import com.fathy.alfred.backend.settings.application.port.out.VariablesChangedNotificationPort;
import com.fathy.alfred.backend.settings.domain.model.GlobalVariablesState;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Validates and mutates the shared, multi-environment variable state before it reaches persistent
 * storage or the proxies - contracts.md section 1 (B3 variables by source, C2 environments, D6
 * secret variables). See {@link GlobalVariablesState} for the storage shape itself.
 */
@Service
public class GlobalVariablesService implements ManageGlobalVariablesUseCase {
    private static final Pattern NAME = GlobalVariablesState.NAME;
    private static final Pattern ENVIRONMENT_NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}");
    /** Combined count of distinct variable+fallback names per environment - tombstones (updatedAt only) don't count. */
    private static final int MAX_NAMES = 1000;
    private static final int MAX_ENVIRONMENTS = 20;
    private static final int MAX_VALUE_CHARS = 1_048_576;

    private final GlobalVariablesStorePort store;
    private final VariablesChangedNotificationPort notifications;
    private final Clock clock;

    @Autowired
    public GlobalVariablesService(GlobalVariablesStorePort store, VariablesChangedNotificationPort notifications) {
        this(store, notifications, Clock.systemUTC());
    }

    GlobalVariablesService(GlobalVariablesStorePort store, VariablesChangedNotificationPort notifications, Clock clock) {
        this.store = store;
        this.notifications = notifications;
        this.clock = clock;
    }

    @Override public Map<String, Object> get() {
        return GlobalVariablesState.view(store.load());
    }

    /**
     * Full-state replace (bulk {@code PUT /settings/variables}) of the ACTIVE environment. Computes
     * the diff against whatever is actually in the store at update time (not a stale copy read
     * earlier) and bumps {@code updatedAt}/{@code sources} only for names whose variable or
     * fallback value actually changed - any {@code updatedAt} the client sent is ignored outright.
     * A payload identical to the current state touches nothing and does not broadcast.
     */
    @Override public Map<String, Object> save(Map<String, Object> state) {
        if (state == null) throw new IllegalArgumentException("Variable state is required");
        Map<String, String> newVariables = stringMap(state.getOrDefault("variables", Map.of()), true);
        Map<String, String> newFallbacks = stringMap(state.getOrDefault("fallbacks", Map.of()), true);
        enforceLimits(newVariables, newFallbacks);

        GlobalVariablesStorePort.Update result = store.update(current -> {
            String active = GlobalVariablesState.activeEnvironment(current);
            Map<String, Object> env = GlobalVariablesState.environment(current, active);
            Map<String, String> currentVariables = GlobalVariablesState.variablesOf(env);
            Map<String, String> currentFallbacks = GlobalVariablesState.fallbacksOf(env);
            Map<String, Long> updatedAt = new LinkedHashMap<>(GlobalVariablesState.updatedAtOf(env));
            Map<String, Object> sources = new LinkedHashMap<>(GlobalVariablesState.sourcesOf(env));
            long now = clock.millis();

            Set<String> touched = new LinkedHashSet<>();
            touched.addAll(currentVariables.keySet());
            touched.addAll(newVariables.keySet());
            touched.addAll(currentFallbacks.keySet());
            touched.addAll(newFallbacks.keySet());
            for (String name : touched) {
                if (!Objects.equals(currentVariables.get(name), newVariables.get(name))
                        || !Objects.equals(currentFallbacks.get(name), newFallbacks.get(name))) {
                    updatedAt.put(name, now);
                    if (newVariables.containsKey(name)) sources.put(name, GlobalVariablesState.source("MANUAL", null, null));
                    else sources.remove(name);
                }
            }
            Map<String, Object> nextEnv = GlobalVariablesState.newEnvironment(newVariables, newFallbacks, updatedAt, sources);
            return GlobalVariablesState.withEnvironment(current, active, nextEnv);
        });
        if (result.changed()) notifications.notifyVariablesChanged();
        return GlobalVariablesState.view(result.state());
    }

    /**
     * A proxy GLOBAL capture promoting one value ({@code POST /settings/variables/promoted}) into
     * the active environment - source becomes CAPTURE with {@code ruleId}/{@code ruleName}. A
     * promoted concrete value supersedes a fallback for the same name, mirroring the dashboard's
     * own upsert.
     */
    @Override public Map<String, Object> promote(String name, Object value, String ruleId, String ruleName) {
        validateName(name);
        if (!(value instanceof String text)) {
            throw new IllegalArgumentException("Variables need valid names and text values");
        }
        validateValue(text);
        GlobalVariablesStorePort.Update result = store.update(current ->
                upsertInto(current, GlobalVariablesState.activeEnvironment(current), name, text, "CAPTURE", ruleId, ruleName));
        if (result.changed()) notifications.notifyVariablesChanged();
        return GlobalVariablesState.view(result.state());
    }

    @Override public Map<String, Object> upsert(String name, String value) {
        validateName(name);
        validateValue(value);
        GlobalVariablesStorePort.Update result = store.update(current ->
                upsertInto(current, GlobalVariablesState.activeEnvironment(current), name, value, "MANUAL", null, null));
        if (result.changed()) notifications.notifyVariablesChanged();
        return GlobalVariablesState.view(result.state());
    }

    @Override public Map<String, Object> remove(String name, String fallbackOrNull) {
        validateName(name);
        if (fallbackOrNull != null) validateValue(fallbackOrNull);
        GlobalVariablesStorePort.Update result = store.update(current -> {
            String active = GlobalVariablesState.activeEnvironment(current);
            Map<String, Object> env = GlobalVariablesState.environment(current, active);
            Map<String, String> variables = new LinkedHashMap<>(GlobalVariablesState.variablesOf(env));
            variables.remove(name);
            Map<String, String> fallbacks = new LinkedHashMap<>(GlobalVariablesState.fallbacksOf(env));
            if (fallbackOrNull != null) fallbacks.put(name, fallbackOrNull);
            else fallbacks.remove(name);
            enforceLimits(variables, fallbacks);
            Map<String, Long> updatedAt = new LinkedHashMap<>(GlobalVariablesState.updatedAtOf(env));
            updatedAt.put(name, clock.millis());
            Map<String, Object> sources = new LinkedHashMap<>(GlobalVariablesState.sourcesOf(env));
            sources.remove(name);
            Map<String, Object> nextEnv = GlobalVariablesState.newEnvironment(variables, fallbacks, updatedAt, sources);
            return GlobalVariablesState.withEnvironment(current, active, nextEnv);
        });
        if (result.changed()) notifications.notifyVariablesChanged();
        return GlobalVariablesState.view(result.state());
    }

    @Override public Map<String, Object> setSecret(String name, boolean secret) {
        validateName(name);
        GlobalVariablesStorePort.Update result = store.update(current -> {
            List<String> secrets = new ArrayList<>(GlobalVariablesState.secrets(current));
            if (secret) {
                if (!secrets.contains(name)) secrets.add(name);
            } else {
                secrets.remove(name);
            }
            return GlobalVariablesState.withSecrets(current, secrets);
        });
        if (result.changed()) notifications.notifyVariablesChanged();
        return GlobalVariablesState.view(result.state());
    }

    @Override public Map<String, Object> createEnvironment(String name, String copyFromOrNull) {
        validateEnvironmentName(name);
        GlobalVariablesStorePort.Update result = store.update(current -> {
            Map<String, Object> environments = GlobalVariablesState.environments(current);
            if (environments.containsKey(name)) {
                throw new IllegalArgumentException("An environment named \"" + name + "\" already exists.");
            }
            if (environments.size() >= MAX_ENVIRONMENTS) {
                throw new IllegalArgumentException("At most " + MAX_ENVIRONMENTS + " environments are allowed.");
            }
            Map<String, Object> newEnv;
            if (copyFromOrNull != null) {
                if (!environments.containsKey(copyFromOrNull)) {
                    throw new IllegalArgumentException("Unknown environment \"" + copyFromOrNull + "\" to copy from.");
                }
                Map<String, Object> source = GlobalVariablesState.environment(current, copyFromOrNull);
                newEnv = GlobalVariablesState.newEnvironment(GlobalVariablesState.variablesOf(source),
                        GlobalVariablesState.fallbacksOf(source), GlobalVariablesState.updatedAtOf(source),
                        GlobalVariablesState.sourcesOf(source));
            } else {
                newEnv = GlobalVariablesState.newEnvironment(Map.of(), Map.of(), Map.of(), Map.of());
            }
            return GlobalVariablesState.withEnvironment(current, name, newEnv);
        });
        if (result.changed()) notifications.notifyVariablesChanged();
        return GlobalVariablesState.view(result.state());
    }

    /** Republishes {@code variables.json} for the newly-active environment - see the store's save(). */
    @Override public Map<String, Object> activateEnvironment(String name) {
        if (name == null) throw new IllegalArgumentException("An environment name is required.");
        GlobalVariablesStorePort.Update result = store.update(current -> {
            if (!GlobalVariablesState.environments(current).containsKey(name)) {
                throw new IllegalArgumentException("Unknown environment \"" + name + "\".");
            }
            return GlobalVariablesState.withActiveEnvironment(current, name);
        });
        if (result.changed()) notifications.notifyVariablesChanged();
        return GlobalVariablesState.view(result.state());
    }

    @Override public Map<String, Object> deleteEnvironment(String name) {
        if (name == null) throw new IllegalArgumentException("An environment name is required.");
        GlobalVariablesStorePort.Update result = store.update(current -> {
            Map<String, Object> environments = GlobalVariablesState.environments(current);
            if (!environments.containsKey(name)) {
                throw new IllegalArgumentException("Unknown environment \"" + name + "\".");
            }
            if (name.equals(GlobalVariablesState.activeEnvironment(current))) {
                throw new IllegalArgumentException("Cannot delete the active environment.");
            }
            if (environments.size() <= 1) {
                throw new IllegalArgumentException("Cannot delete the last environment.");
            }
            return GlobalVariablesState.withoutEnvironment(current, name);
        });
        if (result.changed()) notifications.notifyVariablesChanged();
        return GlobalVariablesState.view(result.state());
    }

    @Override public Map<String, Object> exportEnvironment(String name) {
        Map<String, Object> current = store.load();
        if (!GlobalVariablesState.environments(current).containsKey(name)) {
            throw new IllegalArgumentException("Unknown environment \"" + name + "\".");
        }
        Map<String, Object> env = GlobalVariablesState.environment(current, name);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("name", name);
        out.put("variables", env.get("variables"));
        out.put("fallbacks", env.get("fallbacks"));
        return out;
    }

    @Override public Map<String, Object> importEnvironment(String environment, Object variables, Object fallbacks, String mode) {
        validateEnvironmentName(environment);
        if (!"MERGE".equals(mode) && !"REPLACE".equals(mode)) {
            throw new IllegalArgumentException("mode must be MERGE or REPLACE.");
        }
        Map<String, String> importedVariables = stringMap(variables, true);
        Map<String, String> importedFallbacks = fallbacks == null ? Map.of() : stringMap(fallbacks, true);
        boolean replace = "REPLACE".equals(mode);

        GlobalVariablesStorePort.Update result = store.update(current -> {
            Map<String, Object> environments = GlobalVariablesState.environments(current);
            if (!environments.containsKey(environment) && environments.size() >= MAX_ENVIRONMENTS) {
                throw new IllegalArgumentException("At most " + MAX_ENVIRONMENTS + " environments are allowed.");
            }
            Map<String, Object> env = GlobalVariablesState.environment(current, environment);
            Map<String, String> nextVariables;
            Map<String, String> nextFallbacks;
            Map<String, Long> updatedAt = new LinkedHashMap<>(GlobalVariablesState.updatedAtOf(env));
            Map<String, Object> sources = new LinkedHashMap<>(GlobalVariablesState.sourcesOf(env));
            if (replace) {
                nextVariables = new LinkedHashMap<>(importedVariables);
                nextFallbacks = new LinkedHashMap<>(importedFallbacks);
                // A replaced-away name's tombstone/source no longer describes anything real.
                Set<String> kept = new LinkedHashSet<>(nextVariables.keySet());
                kept.addAll(nextFallbacks.keySet());
                updatedAt.keySet().retainAll(kept);
                sources.keySet().retainAll(kept);
            } else {
                nextVariables = new LinkedHashMap<>(GlobalVariablesState.variablesOf(env));
                nextVariables.putAll(importedVariables);
                nextFallbacks = new LinkedHashMap<>(GlobalVariablesState.fallbacksOf(env));
                nextFallbacks.putAll(importedFallbacks);
            }
            enforceLimits(nextVariables, nextFallbacks);
            long now = clock.millis();
            for (String name : importedVariables.keySet()) {
                updatedAt.put(name, now);
                sources.put(name, GlobalVariablesState.source("IMPORT", null, null));
            }
            Map<String, Object> nextEnv = GlobalVariablesState.newEnvironment(nextVariables, nextFallbacks, updatedAt, sources);
            return GlobalVariablesState.withEnvironment(current, environment, nextEnv);
        });
        if (result.changed()) notifications.notifyVariablesChanged();
        return GlobalVariablesState.view(result.state());
    }

    private Map<String, Object> upsertInto(Map<String, Object> current, String envName, String name, String value,
            String sourceKind, String ruleId, String ruleName) {
        Map<String, Object> env = GlobalVariablesState.environment(current, envName);
        Map<String, String> variables = new LinkedHashMap<>(GlobalVariablesState.variablesOf(env));
        variables.put(name, value);
        Map<String, String> fallbacks = new LinkedHashMap<>(GlobalVariablesState.fallbacksOf(env));
        fallbacks.remove(name);
        enforceLimits(variables, fallbacks);
        Map<String, Long> updatedAt = new LinkedHashMap<>(GlobalVariablesState.updatedAtOf(env));
        updatedAt.put(name, clock.millis());
        Map<String, Object> sources = new LinkedHashMap<>(GlobalVariablesState.sourcesOf(env));
        sources.put(name, GlobalVariablesState.source(sourceKind, ruleId, ruleName));
        Map<String, Object> nextEnv = GlobalVariablesState.newEnvironment(variables, fallbacks, updatedAt, sources);
        return GlobalVariablesState.withEnvironment(current, envName, nextEnv);
    }

    private static void validateName(String name) {
        if (name == null || !NAME.matcher(name).matches() || name.startsWith("this.")) {
            throw new IllegalArgumentException("Variable name needs letters, digits, dots, dashes or underscores, starting with a letter - and never with this.");
        }
    }

    private static void validateEnvironmentName(String name) {
        if (name == null || !ENVIRONMENT_NAME.matcher(name).matches()) {
            throw new IllegalArgumentException("Environment name needs 1-40 characters: letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit.");
        }
    }

    private static void validateValue(String value) {
        if (value == null) {
            throw new IllegalArgumentException("Variables need valid names and text values");
        }
        if (value.length() > MAX_VALUE_CHARS) {
            throw new IllegalArgumentException("Variable values must be " + MAX_VALUE_CHARS + " characters or fewer.");
        }
    }

    /** Union of variable+fallback names is what's capped per environment - tombstones live only in updatedAt. */
    private static void enforceLimits(Map<String, String> variables, Map<String, String> fallbacks) {
        Set<String> names = new LinkedHashSet<>(variables.keySet());
        names.addAll(fallbacks.keySet());
        if (names.size() > MAX_NAMES) {
            throw new IllegalArgumentException("At most " + MAX_NAMES + " variable/fallback names are allowed per environment.");
        }
    }

    private static Map<String, String> stringMap(Object value, boolean reserveLocalNamespace) {
        if (!(value instanceof Map<?, ?> raw)) throw new IllegalArgumentException("Variables must be an object");
        Map<String, String> result = new LinkedHashMap<>();
        for (var entry : raw.entrySet()) {
            if (!(entry.getKey() instanceof String name) || (!NAME.matcher(name).matches() || (reserveLocalNamespace && name.startsWith("this.")))
                    || !(entry.getValue() instanceof String text) || text.length() > MAX_VALUE_CHARS) {
                throw new IllegalArgumentException("Variables need valid names and text values, " + MAX_VALUE_CHARS + " characters or fewer.");
            }
            result.put(name, text);
        }
        return result;
    }
}
