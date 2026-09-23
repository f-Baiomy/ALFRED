package com.fathy.alfred.backend.sessioncycles.adapter.out.sqlite;

import com.fathy.alfred.backend.sessioncycles.application.port.out.CycleSpacersStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Optional;

/** Thin CycleSpacersStorePort implementation - every actual SQL/JDBC detail lives in {@link SqliteSessionCyclesRepository}, mirroring SqliteCapturedCallsStoreAdapter. */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.session-cycles", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteCycleSpacersStoreAdapter implements CycleSpacersStorePort {

    private final SqliteSessionCyclesRepository repository;

    public SqliteCycleSpacersStoreAdapter(SqliteSessionCyclesRepository repository) {
        this.repository = repository;
    }

    @Override
    public List<CycleSpacer> findAllByCycle(String cycleId) {
        return repository.findAllSpacersByCycle(cycleId);
    }

    @Override
    public CycleSpacer create(String cycleId, String label, String beforeCallId, String anchorTimestamp) {
        return repository.createSpacer(cycleId, label, beforeCallId, anchorTimestamp);
    }

    @Override
    public Optional<CycleSpacer> rename(String cycleId, String spacerId, String label) {
        return repository.renameSpacer(cycleId, spacerId, label);
    }

    @Override
    public Optional<CycleSpacer> move(String cycleId, String spacerId, String beforeCallId, String anchorTimestamp) {
        return repository.moveSpacer(cycleId, spacerId, beforeCallId, anchorTimestamp);
    }

    @Override
    public boolean delete(String cycleId, String spacerId) {
        return repository.deleteSpacer(cycleId, spacerId);
    }

    @Override
    public void deleteAllForCycle(String cycleId) {
        repository.deleteAllSpacersForCycle(cycleId);
    }

    @Override
    public void dropAnchorsTo(String cycleId, List<String> capturedCallIds) {
        repository.dropSpacerAnchorsTo(cycleId, capturedCallIds);
    }
}
