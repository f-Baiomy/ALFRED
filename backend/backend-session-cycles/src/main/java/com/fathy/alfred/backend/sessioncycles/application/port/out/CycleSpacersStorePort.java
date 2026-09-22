package com.fathy.alfred.backend.sessioncycles.application.port.out;

import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;

import java.util.List;
import java.util.Optional;

/** Outbound port: per-cycle spacer (named divider between captured calls) persistence. */
public interface CycleSpacersStorePort {

    List<CycleSpacer> findAllByCycle(String cycleId);

    CycleSpacer create(String cycleId, String label, String beforeCallId);

    /** @return the updated spacer, or empty if no spacer with this id exists in this cycle. */
    Optional<CycleSpacer> rename(String cycleId, String spacerId, String label);

    /** Re-anchors a spacer to sit before a different call (by the underlying CallRecord's id - see CycleSpacer's doc), or after every call if null. @return the updated spacer, or empty if no spacer with this id exists in this cycle. */
    Optional<CycleSpacer> move(String cycleId, String spacerId, String beforeCallId);

    /** @return true if a spacer with this id existed in this cycle and was removed. */
    boolean delete(String cycleId, String spacerId);

    /** Deletes every spacer for this cycle - called when the cycle's captured calls (or the cycle itself) are deleted. */
    void deleteAllForCycle(String cycleId);

    /**
     * Moves any spacer anchored before one of these (underlying CallRecord) call ids to the end
     * (beforeCallId = null) instead of leaving it pointing at a call that no longer exists. Called
     * whenever captured calls are removed - a spacer whose anchor call was deleted would otherwise
     * become unreachable (still stored, but never rendered, since nothing matches its beforeCallId
     * anymore). Callers holding only the CapturedCall wrapper id (as removeCall/removeCalls do) must
     * translate it to the underlying call id first - see SessionCyclesService#underlyingCallIdOf.
     */
    void dropAnchorsTo(String cycleId, List<String> callIds);
}
