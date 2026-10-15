package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.out.CycleNamesPort;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetSessionCycleUseCase;
import org.springframework.stereotype.Component;

import java.util.Optional;

/** A session cycle's name for the board chats' export and import (specs/022). */
@Component
public class BoardCycleNamesAdapter implements CycleNamesPort {

    private final GetSessionCycleUseCase cycles;

    public BoardCycleNamesAdapter(GetSessionCycleUseCase cycles) {
        this.cycles = cycles;
    }

    @Override
    public Optional<String> nameOf(String cycleId) {
        if (cycleId == null || cycleId.isBlank()) {
            return Optional.empty();
        }
        try {
            return cycles.getById(cycleId).map(c -> c.name() == null ? "" : c.name());
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }
}
