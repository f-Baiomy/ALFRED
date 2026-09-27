package com.fathy.alfred.backend.settings.application.service;

import com.fathy.alfred.backend.settings.application.port.in.ManageGlobalVariablesUseCase;
import com.fathy.alfred.backend.settings.application.port.out.GlobalVariablesStorePort;
import com.fathy.alfred.backend.settings.application.port.out.VariablesChangedNotificationPort;
import org.springframework.stereotype.Service;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/** Validates the shared variable state before it reaches persistent storage or the proxies. */
@Service
public class GlobalVariablesService implements ManageGlobalVariablesUseCase {
    private static final Pattern NAME = Pattern.compile("[A-Za-z][A-Za-z0-9_.-]*");
    private final GlobalVariablesStorePort store;
    private final VariablesChangedNotificationPort notifications;

    public GlobalVariablesService(GlobalVariablesStorePort store, VariablesChangedNotificationPort notifications) {
        this.store = store;
        this.notifications = notifications;
    }

    @Override public Map<String, Object> get() { return normalize(store.load(), false); }
    @Override public Map<String, Object> save(Map<String, Object> state) {
        Map<String, Object> saved = store.save(normalize(state, true));
        notifications.notifyVariablesChanged();
        return saved;
    }

    /**
     * A proxy GLOBAL capture promoting one value ({@code POST /settings/variables/promoted}).
     * Merged server-side onto the stored state so the promotion and any concurrent UI edit
     * serialize through the store instead of the proxy having to read-modify-write the whole
     * object over HTTP. A promoted concrete value supersedes a fallback for the same name,
     * mirroring the dashboard's own upsert. Broadcasts like any other change.
     */
    @Override public Map<String, Object> promote(String name, Object value) {
        if (name == null || !NAME.matcher(name).matches() || name.startsWith("this.")) {
            throw new IllegalArgumentException("Variable name needs letters, digits, dots, dashes or underscores, starting with a letter - and never with this.");
        }
        if (!(value instanceof String text)) {
            throw new IllegalArgumentException("Variables need valid names and text values");
        }
        Map<String, Object> current = store.load();
        Map<String, Object> variables = new LinkedHashMap<>(stringMapOrEmpty(current.get("variables")));
        variables.put(name, text);
        Map<String, Object> fallbacks = new LinkedHashMap<>(stringMapOrEmpty(current.get("fallbacks")));
        fallbacks.remove(name);
        Map<String, Object> next = store.save(Map.of("variables", variables, "fallbacks", fallbacks));
        notifications.notifyVariablesChanged();
        return next;
    }

    private static Map<String, Object> stringMapOrEmpty(Object value) {
        if (value instanceof Map<?, ?> raw) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (var entry : raw.entrySet()) {
                if (entry.getKey() instanceof String key) out.put(key, entry.getValue());
            }
            return out;
        }
        return Map.of();
    }

    private static Map<String, Object> normalize(Map<String, Object> state, boolean reserveLocalNamespace) {
        if (state == null) throw new IllegalArgumentException("Variable state is required");
        return Map.of(
                "variables", stringMap(state.getOrDefault("variables", Map.of()), reserveLocalNamespace),
                "fallbacks", stringMap(state.getOrDefault("fallbacks", Map.of()), reserveLocalNamespace));
    }

    private static Map<String, String> stringMap(Object value, boolean reserveLocalNamespace) {
        if (!(value instanceof Map<?, ?> raw)) throw new IllegalArgumentException("Variables must be an object");
        Map<String, String> result = new LinkedHashMap<>();
        for (var entry : raw.entrySet()) {
            if (!(entry.getKey() instanceof String name) || (!NAME.matcher(name).matches() || (reserveLocalNamespace && name.startsWith("this.")))
                    || !(entry.getValue() instanceof String text)) {
                throw new IllegalArgumentException("Variables need valid names and text values");
            }
            result.put(name, text);
        }
        return result;
    }
}
