package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.CycleCall;

import java.util.List;

/**
 * The newest live inbound calls, signed like a card's call - what the regression watch compares Done / Verified cards
 * with. Implemented in backend-app/boardbridge.
 */
public interface LiveCallsPort {

    List<CycleCall> recent(int limit);
}
