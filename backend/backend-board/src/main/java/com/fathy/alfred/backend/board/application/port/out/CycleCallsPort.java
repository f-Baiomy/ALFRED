package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.CycleCall;

import java.util.List;

/**
 * Every call a session cycle captured, with its signature - implemented in backend-app/boardbridge with the cycle's
 * captured calls and triage's endpoint normalizer, the same way CallSignaturePort signs a card's call. Empty for an
 * unknown cycle. At most {@code limit} calls.
 */
public interface CycleCallsPort {

    List<CycleCall> calls(String cycleId, int limit);

    /** One session cycle's own calls - never its board's other cycles (specs/027: a task key resolves to every related cycle). */
    default List<CycleCall> ofCycle(String cycleId, int limit) {
        return calls(cycleId, limit);
    }

    /**
     * specs/035: the mention ref of a call {@link #calls} listed for {@code taskKey} from another Alfred's cycle -
     * {@code in:<call>@<cycle>@<link>} - so a card links that call and not a call of this Alfred; empty for this
     * Alfred's own calls (their usual refs apply).
     */
    default java.util.Optional<String> remoteRef(String taskKey, CycleCall call) {
        return java.util.Optional.empty();
    }
}
