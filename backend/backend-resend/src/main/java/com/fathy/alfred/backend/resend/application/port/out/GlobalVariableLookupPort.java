package com.fathy.alfred.backend.resend.application.port.out;

import java.util.Map;

/** Reads the current global variable state without coupling resend to settings persistence. */
public interface GlobalVariableLookupPort {
    VariableState current();

    record VariableState(Map<String, String> variables, Map<String, String> fallbacks) {
        public VariableState {
            variables = Map.copyOf(variables);
            fallbacks = Map.copyOf(fallbacks);
        }
    }
}
