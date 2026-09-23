package com.fathy.alfred.backend.sessioncycles.application.port.out;

import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;
import com.fathy.alfred.backend.sessioncycles.domain.model.LegacyCycleSpacer;

import java.util.List;
import java.util.Optional;

/** Outbound port: per-cycle spacer (named divider between captured calls) persistence. */
public interface CycleSpacersStorePort {

    /** Every spacer in this cycle, in creation order. A spacer still in the legacy form (see findLegacyByCycle) reads back with both anchor fields null until it is converted. */
    List<CycleSpacer> findAllByCycle(String cycleId);

    /**
     * Spacers stored before spacers anchored to the call above them - still in the "sits before
     * this call" form - so the caller can convert them (see LegacySpacerAnchors). Converting is a
     * {@link #move}, which stores the new form and drops the spacer from this list for good.
     */
    List<LegacyCycleSpacer> findLegacyByCycle(String cycleId);

    CycleSpacer create(String cycleId, String label, String afterCallId, String anchorTimestamp);

    /** @return the updated spacer, or empty if no spacer with this id exists in this cycle. */
    Optional<CycleSpacer> rename(String cycleId, String spacerId, String label);

    /** Re-anchors a spacer to sit right after a different call (by the underlying CallRecord's id, plus that call's timestamp - see CycleSpacer's doc), or above every call if both are null. Sets both fields exactly as given. @return the updated spacer, or empty if no spacer with this id exists in this cycle. */
    Optional<CycleSpacer> move(String cycleId, String spacerId, String afterCallId, String anchorTimestamp);

    /** @return true if a spacer with this id existed in this cycle and was removed. */
    boolean delete(String cycleId, String spacerId);

    /** Deletes every spacer for this cycle - called when the cycle's captured calls (or the cycle itself) are deleted. */
    void deleteAllForCycle(String cycleId);

    /**
     * Clears the anchor id of any spacer anchored to one of these (underlying CallRecord) call ids,
     * instead of leaving it pointing at a call that no longer exists. anchorTimestamp is KEPT, so the
     * spacer stays at the same point in time rather than jumping to the top. Applies to legacy
     * spacers too, so their conversion later sees the call as gone. Called whenever captured calls
     * are removed. Callers holding only the CapturedCall wrapper id (as removeCall/removeCalls do)
     * must translate it to the underlying call id first - see SessionCyclesService#underlyingCallIdOf.
     */
    void dropAnchorsTo(String cycleId, List<String> callIds);
}
