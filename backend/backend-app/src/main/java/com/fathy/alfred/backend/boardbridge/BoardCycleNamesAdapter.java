package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.out.CycleNamesPort;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetSessionCycleUseCase;
import org.springframework.stereotype.Component;

import java.util.Optional;

/** A session cycle's name for the board chats' export and import (specs/022). */
@Component
public class BoardCycleNamesAdapter implements CycleNamesPort {

    private final GetSessionCycleUseCase cycles;
    private final org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.linksbridge.RemoteBoardData> remote;

    public BoardCycleNamesAdapter(GetSessionCycleUseCase cycles,
                                  org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.linksbridge.RemoteBoardData> remote) {
        this.cycles = cycles;
        this.remote = remote;
    }

    @Override
    public Optional<String> nameOf(String cycleId) {
        if (cycleId == null || cycleId.isBlank()) {
            return Optional.empty();
        }
        com.fathy.alfred.backend.linksbridge.RemoteBoardData r = remote.getIfAvailable();
        if (r != null && r.isRemote(cycleId)) {
            return r.name(cycleId); // specs/035: a streamed-in cycle's name, as its owner calls it
        }
        try {
            return cycles.getById(cycleId).map(c -> c.name() == null ? "" : c.name());
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }
}
