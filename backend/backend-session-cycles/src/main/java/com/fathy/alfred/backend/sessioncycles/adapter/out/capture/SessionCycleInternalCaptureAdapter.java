package com.fathy.alfred.backend.sessioncycles.adapter.out.capture;

import com.fathy.alfred.backend.internalcalls.application.port.out.NewInternalCallObserverPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedInternalCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CycleSpacersStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;
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
    private final CycleSpacersStorePort spacersStore;

    public SessionCycleInternalCaptureAdapter(SessionCycleMetadataStorePort metadataStore, CapturedInternalCallsStorePort capturedInternalCallsStore, CycleSpacersStorePort spacersStore) {
        this.metadataStore = metadataStore;
        this.capturedInternalCallsStore = capturedInternalCallsStore;
        this.spacersStore = spacersStore;
    }

    @Override
    public List<String> onCallCompleted(CallRecord call) {
        List<String> cycleIds = recordingCycleIds();
        cycleIds.forEach(cycleId -> {
            capturedInternalCallsStore.append(cycleId, call);
            pinTrailingSpacersTo(cycleId, call);
        });
        return cycleIds;
    }

    private List<String> recordingCycleIds() {
        return metadataStore.findAll().stream()
                .filter(cycle -> cycle.status() == SessionCycleStatus.RECORDING)
                .map(SessionCycle::id)
                .toList();
    }

    /**
     * See SessionCycleCaptureAdapter#pinTrailingSpacersTo (the external-calls twin of this
     * adapter) for the full rationale - this is the same fix, needed here too since inbound
     * traffic captured while RECORDING goes through this class instead, and spacers are shared
     * across both external and internal calls in the same cycle. Never anchors to an OPTIONS
     * preflight either, for the same reason as that twin - confirmed live: a spacer pinned to a
     * captured OPTIONS call vanished from every view, since OPTIONS calls are hidden by default.
     */
    private void pinTrailingSpacersTo(String cycleId, CallRecord call) {
        if ("OPTIONS".equalsIgnoreCase(call.method())) return;
        for (CycleSpacer spacer : spacersStore.findAllByCycle(cycleId)) {
            // Both null = a true trailing spacer. One with only a timestamp lost its anchor call to a
            // removal and is still placed by that time - re-pinning it here would yank it forward.
            if (spacer.beforeCallId() == null && spacer.anchorTimestamp() == null) {
                spacersStore.move(cycleId, spacer.id(), call.id(), call.timestamp());
            }
        }
    }
}
