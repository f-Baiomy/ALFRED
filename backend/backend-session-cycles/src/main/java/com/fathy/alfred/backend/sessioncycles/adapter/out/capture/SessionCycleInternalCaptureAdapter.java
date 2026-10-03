package com.fathy.alfred.backend.sessioncycles.adapter.out.capture;

import com.fathy.alfred.backend.internalcalls.application.port.out.NewInternalCallObserverPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedInternalCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ReliveRunCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.ReliveRunIds;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Implements backend-internal-calls' NewInternalCallObserverPort so InternalCallsService can fan a
 * completed call out to every recording session-cycle without knowing this slice exists - the
 * internal-calls mirror of SessionCycleCaptureAdapter. Much simpler than that adapter: this slice
 * has no two-phase capture concept at all (backend-internal-calls only ever fires on completion),
 * so there is no prepare-time bookkeeping to do - every RECORDING cycle at completion time simply
 * captures the call.
 */
@Component
public class SessionCycleInternalCaptureAdapter implements NewInternalCallObserverPort {

    private final SessionCycleMetadataStorePort metadataStore;
    private final CapturedInternalCallsStorePort capturedInternalCallsStore;

    private final ReliveRunCyclesUseCase runCycles;

    public SessionCycleInternalCaptureAdapter(SessionCycleMetadataStorePort metadataStore, CapturedInternalCallsStorePort capturedInternalCallsStore, ReliveRunCyclesUseCase runCycles) {
        this.runCycles = runCycles;
        this.metadataStore = metadataStore;
        this.capturedInternalCallsStore = capturedInternalCallsStore;
    }

    @Override
    public List<String> onCallCompleted(CallRecord call) {
        List<String> cycleIds = targetCycleIds(call.relive());
        cycleIds.forEach(cycleId -> capturedInternalCallsStore.append(cycleId, call));
        return cycleIds;
    }

    /** Where a call is captured: a call of a Relive run only into that run's own cycle (never a
     *  recording one - the run keeps its calls), any other call into every RECORDING cycle. */
    private List<String> targetCycleIds(com.fasterxml.jackson.databind.JsonNode relive) {
        List<String> runIds = ReliveRunIds.of(relive);
        if (!runIds.isEmpty()) {
            return runIds.stream().map(runCycles::captureCycleId).distinct().toList();
        }
        return recordingCycleIds();
    }

    private List<String> recordingCycleIds() {
        return metadataStore.findAll().stream()
                .filter(cycle -> cycle.status() == SessionCycleStatus.RECORDING && cycle.reliveRunId() == null)
                .map(SessionCycle::id)
                .toList();
    }
}
