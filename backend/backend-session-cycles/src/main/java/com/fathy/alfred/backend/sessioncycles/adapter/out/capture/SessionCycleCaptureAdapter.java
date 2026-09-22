package com.fathy.alfred.backend.sessioncycles.adapter.out.capture;

import com.fathy.alfred.backend.calls.application.port.out.NewCallObserverPort;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallTiming;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CycleSpacersStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Implements backend-calls' NewCallObserverPort so CallsService can fan a call out to every
 * recording session-cycle without knowing this slice exists - the same shape
 * WebSocketCallNotificationAdapter already uses for CallNotificationPort. Any number of cycles
 * can be RECORDING at once; a call lands in all of them.
 *
 * <p>Two-phase logging support depends on the active storage adapter
 * ({@link CapturedCallsStorePort#supportsTwoPhaseCapture()}): the SQLite adapter captures a call
 * the moment it's prepared (state IN_PROGRESS) and fills in the outcome later, in whichever
 * cycles were RECORDING at prepare time - remembered here in {@link #capturedCycleIdsByCallId}
 * since which cycles captured it is decided once, at prepare time, not re-evaluated at complete
 * time (a cycle might stop recording in between; it should still get the completed call it
 * already captured). The file adapter doesn't support this, so it defers the whole decision to
 * completion time instead, exactly as this adapter behaved before two-phase logging existed.
 */
@Component
public class SessionCycleCaptureAdapter implements NewCallObserverPort {

    private final SessionCycleMetadataStorePort metadataStore;
    private final CapturedCallsStorePort capturedCallsStore;
    private final CycleSpacersStorePort spacersStore;

    /** Which cycles captured a given (still in-progress) call id at prepare time - consumed and removed once that call completes. Only ever populated when the storage adapter supports two-phase capture. */
    private final Map<String, List<String>> capturedCycleIdsByCallId = new ConcurrentHashMap<>();

    public SessionCycleCaptureAdapter(SessionCycleMetadataStorePort metadataStore, CapturedCallsStorePort capturedCallsStore, CycleSpacersStorePort spacersStore) {
        this.metadataStore = metadataStore;
        this.capturedCallsStore = capturedCallsStore;
        this.spacersStore = spacersStore;
    }

    @Override
    public List<String> onNewCall(CallRecord call) {
        List<String> cycleIds = recordingCycleIds();
        cycleIds.forEach(cycleId -> {
            capturedCallsStore.append(cycleId, call);
            pinTrailingSpacersTo(cycleId, call);
        });
        return cycleIds;
    }

    @Override
    public List<String> onCallPrepared(CallRecord call) {
        if (!capturedCallsStore.supportsTwoPhaseCapture()) {
            // File mode: nothing captured yet - onCallCompleted decides fresh once this call
            // resolves, exactly like onNewCall always has.
            return List.of();
        }
        List<String> cycleIds = recordingCycleIds();
        cycleIds.forEach(cycleId -> {
            capturedCallsStore.append(cycleId, call);
            pinTrailingSpacersTo(cycleId, call);
        });
        if (!cycleIds.isEmpty()) {
            capturedCycleIdsByCallId.put(call.id(), cycleIds);
        }
        return cycleIds;
    }

    /**
     * A spacer with beforeCallId null renders after every captured call so far - right for a
     * spacer added while it really is the last one, but left alone it would also render after
     * every call captured LATER, sliding past new live traffic instead of staying where the user
     * put it (confirmed live: adding a spacer at the end of a RECORDING cycle, then letting more
     * traffic capture into it, showed each new call appearing below the spacer instead of above
     * it). Freezes it the first time anything is captured after it, by re-anchoring every
     * still-trailing spacer to sit right before the call just captured - idempotent per call,
     * since a spacer that's already anchored to a real id is no longer trailing and is left alone.
     * Mirrors SessionCyclesService#pinTrailingSpacersTo, called from its own (manual copy/import)
     * capture path - kept as a small duplicate rather than a cross-adapter call, since this class
     * only otherwise depends on ports, not the application service.
     *
     * <p>Never anchors to an OPTIONS preflight - see SessionCyclesService#pinTrailingSpacersTo's
     * doc for why (confirmed live: a spacer pinned to one simply vanished from every view, since
     * OPTIONS calls are hidden by default and the merge can't inline a spacer against a row that
     * isn't rendered).
     */
    private void pinTrailingSpacersTo(String cycleId, CallRecord call) {
        if ("OPTIONS".equalsIgnoreCase(call.method())) return;
        for (CycleSpacer spacer : spacersStore.findAllByCycle(cycleId)) {
            if (spacer.beforeCallId() == null) {
                spacersStore.move(cycleId, spacer.id(), call.id());
            }
        }
    }

    @Override
    public List<String> onCallCompleted(CallRecord call) {
        if (!capturedCallsStore.supportsTwoPhaseCapture()) {
            // File mode never captured this call at prepare time - capture it fresh now, exactly
            // as the legacy single-shot flow always did.
            return onNewCall(call);
        }
        List<String> cycleIds = capturedCycleIdsByCallId.remove(call.id());
        if (cycleIds == null) {
            // Wasn't captured at prepare time (no cycle was recording then) - nothing to update.
            return List.of();
        }
        // call.timing() and call.interception() are why this takes six and seven arguments: both
        // are only known now, at completion, and the captured row was written while the call was
        // still in flight. Dropping interception here (it used to not even be a parameter) is why
        // a call shown as EDITED with its own "what changed" panel on the live list showed neither
        // once captured into a cycle - the frontend renders both off this exact field.
        cycleIds.forEach(cycleId -> capturedCallsStore.completeCapturedCall(
                cycleId, call.id(), call.response(), call.error(), call.durationMs(), call.timing(), call.interception()));
        return cycleIds;
    }

    private List<String> recordingCycleIds() {
        return metadataStore.findAll().stream()
                .filter(cycle -> cycle.status() == SessionCycleStatus.RECORDING)
                .map(SessionCycle::id)
                .toList();
    }
}
