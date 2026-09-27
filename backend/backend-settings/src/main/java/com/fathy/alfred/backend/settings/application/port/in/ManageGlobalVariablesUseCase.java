package com.fathy.alfred.backend.settings.application.port.in;
import java.util.Map;
public interface ManageGlobalVariablesUseCase {
    Map<String, Object> get();
    Map<String, Object> save(Map<String, Object> state);
    /**
     * Merges one promoted value (a proxy GLOBAL capture) into the stored state. See
     * {@code GlobalVariablesService.promote} for why this is a merge, not a full-state save.
     */
    Map<String, Object> promote(String name, Object value);
}
