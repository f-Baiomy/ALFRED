package com.fathy.alfred.backend.sessioncycles.application.port.out;

import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;

import java.util.List;
import java.util.Optional;

/** Outbound port: per-cycle spacer (named divider between captured calls) persistence. */
public interface CycleSpacersStorePort {

    List<CycleSpacer> findAllByCycle(String cycleId);

    CycleSpacer create(String cycleId, String label, String beforeCallId, String anchorTimestamp);

    /** @return the updated spacer, or empty if no spacer with this id exists in this cycle. */
    Optional<CycleSpacer> rename(String cycleId, String spacerId, String label);

    /** Re-anchors a spacer to sit before a different call (by the underlying CallRecord's id, plus that call's timestamp - see CycleSpacer's doc), or after every call if both are null. Sets both fields exactly as given. @return the updated spacer, or empty if no spacer with this id exists in this cycle. */
    Optional<CycleSpacer> move(String cycleId, String spacerId, String beforeCallId, String anchorTimestamp);

    /** @return true if a spacer with this id existed in this cycle and was removed. */
    boolean delete(String cycleId, String spacerId);

    /** Deletes every spacer for this cycle - called when the cycle's captured calls (or the cycle itself) are deleted. */
    void deleteAllForCycle(String cycleId);

    /**
     * Clears beforeCallId on any spacer anchored before one of these (underlying CallRecord) call
     * ids, instead of leaving it pointing at a call that no longer exists. anchorTimestamp is KEPT,
     * so the spacer stays at the same point in time rather than jumping to the end - and, having a
     * time, it is never mistaken for a trailing spacer and re-pinned to the next captured call.
     * Called whenever captured calls are removed. Callers holding only the CapturedCall wrapper id (as removeCall/removeCalls do) must
     * translate it to the underlying call id first - see SessionCyclesService#underlyingCallIdOf.
     */
    void dropAnchorsTo(String cycleId, List<String> callIds);
}
