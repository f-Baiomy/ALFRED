package com.fathy.alfred.backend.settings.application.service;

import com.fathy.alfred.backend.settings.application.port.in.ManageGlobalVariablesUseCase;
import com.fathy.alfred.backend.settings.application.port.out.GlobalVariablesStorePort;
import org.springframework.stereotype.Service;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/** Validates the shared variable state before it reaches persistent storage or the proxies. */
@Service
public class GlobalVariablesService implements ManageGlobalVariablesUseCase {
    private static final Pattern NAME = Pattern.compile("[A-Za-z][A-Za-z0-9_.-]*");
    private final GlobalVariablesStorePort store;

    public GlobalVariablesService(GlobalVariablesStorePort store) { this.store = store; }

    @Override public Map<String, Object> get() { return normalize(store.load(), false); }
    @Override public Map<String, Object> save(Map<String, Object> state) { return store.save(normalize(state, true)); }

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
