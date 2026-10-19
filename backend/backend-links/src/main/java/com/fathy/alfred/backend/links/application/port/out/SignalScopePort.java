package com.fathy.alfred.backend.links.application.port.out;

import com.fathy.alfred.backend.links.domain.model.Stream;

/**
 * Whether one of this Alfred's own signals (a cycle got calls, a card changed) concerns a stream, so it is passed to the
 * reader - and nothing about anything not streamed is (backend-app/linksbridge).
 */
public interface SignalScopePort {

    boolean concerns(Stream stream, String channel, String json);
}
