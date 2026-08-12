package com.fathy.alfred.backend.sessioncycles.adapter.out.sqlite;

import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Optional;

/**
 * Thin SessionCycleMetadataStorePort implementation - every actual SQL/JDBC detail lives in
 * {@link SqliteSessionCyclesRepository}. The new default; set
 * {@code alfred.storage.session-cycles.type=file} to opt back into the JSON file adapters.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.session-cycles", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteSessionCycleMetadataStoreAdapter implements SessionCycleMetadataStorePort {

    private final SqliteSessionCyclesRepository repository;

    public SqliteSessionCycleMetadataStoreAdapter(SqliteSessionCyclesRepository repository) {
        this.repository = repository;
    }

    @Override
    public List<SessionCycle> findAll() {
        return repository.findAllCycles();
    }

    @Override
    public Optional<SessionCycle> findById(String id) {
        return repository.findCycleById(id);
    }

    @Override
    public SessionCycle save(SessionCycle cycle) {
        return repository.saveCycle(cycle);
    }

    @Override
    public boolean deleteById(String id) {
        return repository.deleteCycleById(id);
    }
}
