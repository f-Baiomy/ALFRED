package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.out.SecretValuesPort;
import com.fathy.alfred.backend.settings.application.port.in.ManageGlobalVariablesUseCase;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The secret variable values the questions form must never carry (specs/037 D10): every value and fallback of a global
 * variable marked secret in the active environment - the same derivation as the UI's SecretValuesService and the MCP
 * server's masking, so the form hides what an export would.
 */
@Component
public class BoardSecretValuesAdapter implements SecretValuesPort {

    private final ManageGlobalVariablesUseCase variables;

    public BoardSecretValuesAdapter(ManageGlobalVariablesUseCase variables) {
        this.variables = variables;
    }

    @Override
    public List<String> secretValues() {
        Map<String, Object> view = variables.get();
        List<String> out = new ArrayList<>();
        if (!(view.get("secrets") instanceof List<?> secrets)) {
            return out;
        }
        for (Object name : secrets) {
            for (String part : List.of("variables", "fallbacks")) {
                if (view.get(part) instanceof Map<?, ?> values && values.get(name) instanceof String v && !v.isBlank()) {
                    out.add(v);
                }
            }
        }
        return out;
    }
}
