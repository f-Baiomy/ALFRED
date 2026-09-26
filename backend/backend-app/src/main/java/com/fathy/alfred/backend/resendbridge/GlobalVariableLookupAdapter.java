package com.fathy.alfred.backend.resendbridge;

import com.fathy.alfred.backend.resend.application.port.out.GlobalVariableLookupPort;
import com.fathy.alfred.backend.settings.application.port.in.ManageGlobalVariablesUseCase;
import org.springframework.stereotype.Component;
import java.util.LinkedHashMap;
import java.util.Map;

/** The app composition root joins resend to the settings slice. */
@Component
public class GlobalVariableLookupAdapter implements GlobalVariableLookupPort {
    private final ManageGlobalVariablesUseCase variables;

    public GlobalVariableLookupAdapter(ManageGlobalVariablesUseCase variables) { this.variables = variables; }

    @Override public VariableState current() {
        Map<String, Object> state = variables.get();
        return new VariableState(strings(state.get("variables")), strings(state.get("fallbacks")));
    }

    private static Map<String, String> strings(Object value) {
        Map<String, String> result = new LinkedHashMap<>();
        if (value instanceof Map<?, ?> map) {
            map.forEach((key, item) -> {
                if (key instanceof String name && item instanceof String text) result.put(name, text);
            });
        }
        return result;
    }
}
