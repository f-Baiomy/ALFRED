package com.alfred.pennyworth.sessioncycles.application.service;

import com.alfred.pennyworth.calls.domain.model.CallRecord;
import com.alfred.pennyworth.sessioncycles.application.port.in.CopyCallsToCycleUseCase;
import com.alfred.pennyworth.sessioncycles.application.port.in.CreateSessionCycleUseCase;
import com.alfred.pennyworth.sessioncycles.application.port.in.DeleteSessionCycleUseCase;
import com.alfred.pennyworth.sessioncycles.application.port.in.GetSessionCycleUseCase;
import com.alfred.pennyworth.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.alfred.pennyworth.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.alfred.pennyworth.sessioncycles.application.port.in.PauseRecordingUseCase;
import com.alfred.pennyworth.sessioncycles.application.port.in.RemoveCapturedCallUseCase;
import com.alfred.pennyworth.sessioncycles.application.port.in.StartRecordingUseCase;
import com.alfred.pennyworth.sessioncycles.application.port.in.UpdateSessionCycleUseCase;
import com.alfred.pennyworth.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.alfred.pennyworth.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.alfred.pennyworth.sessioncycles.domain.model.CapturedCall;
import com.alfred.pennyworth.sessioncycles.domain.model.CopyCallsResult;
import com.alfred.pennyworth.sessioncycles.domain.model.DeleteOutcome;
import com.alfred.pennyworth.sessioncycles.domain.model.NewSessionCycle;
import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycle;
import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycleStatus;
import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycleUpdate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

@Service
public class SessionCyclesService implements
        CreateSessionCycleUseCase,
        ListSessionCyclesUseCase,
        GetSessionCycleUseCase,
        UpdateSessionCycleUseCase,
        StartRecordingUseCase,
        PauseRecordingUseCase,
        DeleteSessionCycleUseCase,
        ListCapturedCallsUseCase,
        RemoveCapturedCallUseCase,
        CopyCallsToCycleUseCase {

    private final SessionCycleMetadataStorePort metadataStore;
    private final CapturedCallsStorePort capturedCallsStore;

    public SessionCyclesService(SessionCycleMetadataStorePort metadataStore, CapturedCallsStorePort capturedCallsStore) {
        this.metadataStore = metadataStore;
        this.capturedCallsStore = capturedCallsStore;
    }

    @Override
    public SessionCycle create(NewSessionCycle newSessionCycle) {
        SessionCycle cycle = new SessionCycle(
                UUID.randomUUID().toString(),
                newSessionCycle.name(),
                Instant.now().toString(),
                newSessionCycle.assignedTo(),
                SessionCycleStatus.PAUSED
        );
        return metadataStore.save(cycle);
    }

    @Override
    public List<SessionCycle> listAll() {
        return metadataStore.findAll();
    }

    @Override
    public Optional<SessionCycle> getById(String id) {
        return metadataStore.findById(id);
    }

    @Override
    public Optional<SessionCycle> update(String id, SessionCycleUpdate update) {
        return metadataStore.findById(id).map(existing -> {
            SessionCycle updated = new SessionCycle(
                    existing.id(),
                    update.name() != null ? update.name() : existing.name(),
                    existing.createdAt(),
                    update.assignedTo() != null ? update.assignedTo() : existing.assignedTo(),
                    existing.status()
            );
            return metadataStore.save(updated);
        });
    }

    @Override
    public Optional<SessionCycle> startRecording(String id) {
        return setStatus(id, SessionCycleStatus.RECORDING);
    }

    @Override
    public Optional<SessionCycle> pauseRecording(String id) {
        return setStatus(id, SessionCycleStatus.PAUSED);
    }

    private Optional<SessionCycle> setStatus(String id, SessionCycleStatus status) {
        return metadataStore.findById(id).map(existing -> {
            if (existing.status() == status) {
                return existing;
            }
            SessionCycle updated = new SessionCycle(
                    existing.id(), existing.name(), existing.createdAt(), existing.assignedTo(), status
            );
            return metadataStore.save(updated);
        });
    }

    @Override
    public DeleteOutcome delete(String id) {
        Optional<SessionCycle> existing = metadataStore.findById(id);
        if (existing.isEmpty()) {
            return DeleteOutcome.NOT_FOUND;
        }
        if (existing.get().status() == SessionCycleStatus.RECORDING) {
            return DeleteOutcome.BLOCKED_RECORDING;
        }
        metadataStore.deleteById(id);
        capturedCallsStore.deleteAllForCycle(id);
        return DeleteOutcome.DELETED;
    }

    /** Captured-calls files are stored oldest-first (append order); reversed here to match GET /calls' newest-first convention, which the frontend's sort/live-merge logic assumes. */
    @Override
    public Optional<List<CapturedCall>> listCalls(String cycleId) {
        return metadataStore.findById(cycleId).map(cycle -> {
            List<CapturedCall> calls = new ArrayList<>(capturedCallsStore.findAllByCycle(cycleId));
            Collections.reverse(calls);
            return calls;
        });
    }

    @Override
    public boolean removeCall(String cycleId, String callId) {
        return capturedCallsStore.removeById(cycleId, callId);
    }

    /**
     * Manual duplication, not the recording fan-out - works regardless of RECORDING/PAUSED.
     * "Already present" is judged by content (timestamp+method+originalUrl, same identity the
     * frontend's callKey() uses), not by CapturedCall id, since a call copied in has no
     * relationship to any id it might already have elsewhere. Skips within the same batch too,
     * so copying a selection containing the same call twice doesn't add it twice either.
     */
    @Override
    public Optional<CopyCallsResult> copyInto(String cycleId, List<CallRecord> calls) {
        return metadataStore.findById(cycleId).map(cycle -> {
            Set<String> existingKeys = new HashSet<>();
            for (CapturedCall captured : capturedCallsStore.findAllByCycle(cycleId)) {
                existingKeys.add(contentKey(captured.call()));
            }

            int added = 0;
            int skipped = 0;
            for (CallRecord call : calls) {
                String key = contentKey(call);
                if (!existingKeys.add(key)) {
                    skipped++;
                    continue;
                }
                capturedCallsStore.append(cycleId, call);
                added++;
            }
            return new CopyCallsResult(added, skipped);
        });
    }

    private static String contentKey(CallRecord call) {
        return Objects.toString(call.timestamp(), "") + "|" + Objects.toString(call.method(), "") + "|" + Objects.toString(call.originalUrl(), "");
    }
}
