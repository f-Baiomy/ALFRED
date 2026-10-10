package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.CallBadge;

import java.util.Collection;
import java.util.List;
import java.util.Map;

/** The cards shown on call rows: per cycle, or for a page of Live Calls ids. */
public interface CallBadgesUseCase {

    int MAX_CALL_IDS = 100;

    Map<String, List<CallBadge>> badgesOfCycle(String cycleId);

    Map<String, List<CallBadge>> badgesOfCalls(Collection<String> callIds);
}
