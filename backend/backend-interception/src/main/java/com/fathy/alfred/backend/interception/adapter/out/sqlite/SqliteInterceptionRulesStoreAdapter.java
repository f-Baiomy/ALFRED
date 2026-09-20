package com.fathy.alfred.backend.interception.adapter.out.sqlite;

import com.fathy.alfred.backend.interception.application.port.out.InterceptionRulesStorePort;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.util.List;

/** Thin port implementation - every SQL detail lives in {@link SqliteInterceptionRulesRepository}. */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.interception", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteInterceptionRulesStoreAdapter implements InterceptionRulesStorePort {

    private final SqliteInterceptionRulesRepository repository;

    public SqliteInterceptionRulesStoreAdapter(SqliteInterceptionRulesRepository repository) {
        this.repository = repository;
    }

    @Override
    public List<InterceptionRule> findAll() {
        return repository.findAll();
    }

    @Override
    public void saveAll(List<InterceptionRule> rules) {
        repository.saveAll(rules);
    }

    @Override
    public boolean isEnabled() {
        return repository.isEnabled();
    }

    @Override
    public void setEnabled(boolean enabled) {
        repository.setEnabled(enabled);
    }
}
