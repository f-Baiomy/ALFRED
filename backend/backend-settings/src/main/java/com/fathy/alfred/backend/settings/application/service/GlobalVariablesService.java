package com.fathy.alfred.backend.settings.application.service;
import com.fathy.alfred.backend.settings.application.port.in.ManageGlobalVariablesUseCase;
import com.fathy.alfred.backend.settings.application.port.out.GlobalVariablesStorePort;
import org.springframework.stereotype.Service;
import java.util.Map;
@Service
public class GlobalVariablesService implements ManageGlobalVariablesUseCase {
    private final GlobalVariablesStorePort store;
    public GlobalVariablesService(GlobalVariablesStorePort store) { this.store = store; }
    @Override public Map<String, Object> get() { return store.load(); }
    @Override public Map<String, Object> save(Map<String, Object> state) { return store.save(state); }
}
