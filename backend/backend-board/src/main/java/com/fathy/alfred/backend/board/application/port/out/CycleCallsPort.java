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
}
