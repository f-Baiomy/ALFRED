package com.fathy.alfred.backend.links.application.port.in;

/**
 * This Alfred's own "something changed" signals (a cycle got calls, a card moved), handed in by backend-app/linksbridge:
 * each goes to the readers whose streams it concerns, so their pages fetch again - no polling (D26 resync covers a
 * reader that was offline).
 */
public interface SignalsUseCase {

    void local(String channel, String json);
}
