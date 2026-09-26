package com.fathy.alfred.backend.settings.application.port.in;
import java.util.Map;
public interface ManageGlobalVariablesUseCase { Map<String, Object> get(); Map<String, Object> save(Map<String, Object> state); }
