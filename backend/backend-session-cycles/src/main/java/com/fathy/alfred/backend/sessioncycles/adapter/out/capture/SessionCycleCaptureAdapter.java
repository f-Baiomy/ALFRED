package com.fathy.alfred.backend.sessioncycles.adapter.out.capture;

import com.fathy.alfred.backend.calls.application.port.out.NewCallObserverPort;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Implements backend-calls' NewCallObserverPort so CallsService can fan a new call out to
 * every recording session-cycle without knowing this slice exists - the same shape
 * WebSocketCallNotificationAdapter already uses for CallNotificationPort. Any number of cycles
 * can be RECORDING at once; a call lands in all of them.
 */
@Component
public class SessionCycleCaptureAdapter implements NewCallObserverPort {

    private final SessionCycleMetadataStorePort metadataStore;
    private final CapturedCallsStorePort capturedCallsStore;

    public SessionCycleCaptureAdapter(SessionCycleMetadataStorePort metadataStore, CapturedCallsStorePort capturedCallsStore) {
        this.metadataStore = metadataStore;
        this.capturedCallsStore = capturedCallsStore;
    }

    @Override
    public List<String> onNewCall(CallRecord call) {
        return metadataStore.findAll().stream()
                .filter(cycle -> cycle.status() == SessionCycleStatus.RECORDING)
                .map(SessionCycle::id)
                .map(cycleId -> {
                    capturedCallsStore.append(cycleId, call);
                    return cycleId;
                })
                .toList();
    }
}
