package com.fathy.alfred.backend.board.application.port.in;

/**
 * A live inbound call finished (specs/016 FR-3): when a Fixed card - or a Verified / Done card with expectations -
 * watches its endpoint, the board signals that card so an open board re-reads its re-test chip. Never slows the caller:
 * the work is queued.
 */
public interface RetestWatchUseCase {

    void callArrived(String project, String endpoint);
}
