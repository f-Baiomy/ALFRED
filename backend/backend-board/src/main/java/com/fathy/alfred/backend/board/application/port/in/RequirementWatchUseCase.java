package com.fathy.alfred.backend.board.application.port.in;

/** Every completed inbound call, offered to the requirement check by its project and endpoint (specs/018). */
public interface RequirementWatchUseCase {

    /** Never blocks and never throws: the check runs on its own thread. */
    void callArrived(String project, String endpoint);
}
