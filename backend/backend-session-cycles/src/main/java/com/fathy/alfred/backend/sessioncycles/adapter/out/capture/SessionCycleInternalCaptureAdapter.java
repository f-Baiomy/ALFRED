package com.fathy.alfred.backend.sessioncycles.adapter.out.capture;

import com.fathy.alfred.backend.internalcalls.application.port.out.NewInternalCallObserverPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedInternalCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
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

    public SessionCycleInternalCaptureAdapter(SessionCycleMetadataStorePort metadataStore, CapturedInternalCallsStorePort capturedInternalCallsStore) {
        this.metadataStore = metadataStore;
        this.capturedInternalCallsStore = capturedInternalCallsStore;
    }

    @Override
    public List<String> onCallCompleted(CallRecord call) {
        List<String> cycleIds = recordingCycleIds();
        cycleIds.forEach(cycleId -> capturedInternalCallsStore.append(cycleId, call));
        return cycleIds;
    }

    private List<String> recordingCycleIds() {
        return metadataStore.findAll().stream()
                .filter(cycle -> cycle.status() == SessionCycleStatus.RECORDING)
                .map(SessionCycle::id)
                .toList();
    }
}
