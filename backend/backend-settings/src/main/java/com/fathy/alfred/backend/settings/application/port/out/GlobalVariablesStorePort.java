package com.fathy.alfred.backend.settings.application.port.out;
import java.util.Map;
public interface GlobalVariablesStorePort { Map<String, Object> load(); Map<String, Object> save(Map<String, Object> state); }
