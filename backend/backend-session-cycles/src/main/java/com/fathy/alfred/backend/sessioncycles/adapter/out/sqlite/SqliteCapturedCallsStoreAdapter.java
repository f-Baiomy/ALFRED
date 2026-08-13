package com.fathy.alfred.backend.sessioncycles.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallSummary;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Optional;

/**
 * Thin CapturedCallsStorePort implementation - every actual SQL/JDBC detail lives in
 * {@link SqliteSessionCyclesRepository}. The new default; set
 * {@code alfred.storage.session-cycles.type=file} to opt back into the JSON file adapter.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.session-cycles", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteCapturedCallsStoreAdapter implements CapturedCallsStorePort {

    private final SqliteSessionCyclesRepository repository;

    public SqliteCapturedCallsStoreAdapter(SqliteSessionCyclesRepository repository) {
        this.repository = repository;
    }

    @Override
    public List<CapturedCall> findAllByCycle(String cycleId) {
        return repository.findAllByCycle(cycleId);
    }

    @Override
    public CapturedCall append(String cycleId, CallRecord call) {
        return repository.append(cycleId, call);
    }

    @Override
    public boolean removeById(String cycleId, String callId) {
        return repository.removeById(cycleId, callId);
    }

    @Override
    public int removeByIds(String cycleId, List<String> callIds) {
        return repository.removeByIds(cycleId, callIds);
    }

    @Override
    public void deleteAllForCycle(String cycleId) {
        repository.deleteAllForCycle(cycleId);
    }

    @Override
    public CallListSupport.Page<CapturedCallSummary> query(String cycleId, String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled) {
        return repository.query(cycleId, search, supplier, sort, offset, limit, paginationEnabled);
    }

    @Override
    public Optional<CapturedCall> findByCallId(String cycleId, String callId) {
        return repository.findByCallId(cycleId, callId);
    }

    @Override
    public long storageSizeBytes() {
        return repository.storageSizeBytes();
    }

    @Override
    public void deleteAll() {
        repository.deleteAllCapturedCalls();
    }

    @Override
    public long countAll() {
        return repository.capturedCallsCountAll();
    }

    @Override
    public boolean supportsTwoPhaseCapture() {
        return true;
    }

    @Override
    public boolean completeCapturedCall(String cycleId, String callId, ResponseData response, String error, Double durationMs) {
        return repository.completeCapturedCall(cycleId, callId, response, error, durationMs);
    }
}
